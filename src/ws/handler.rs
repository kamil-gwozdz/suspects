use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use rand::Rng;
use sqlx::SqlitePool;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::db;
use crate::db::RoomSnapshot;
use crate::game::narrator::{
    WaitFor, build_dawn_script, build_night_script, build_voting_script, canonical_wake_role,
    role_display_name, role_instruction,
};
use crate::game::phases::resolve_night;
use crate::game::roles::{Faction, Role};
use crate::game::scaling::assign_roles;
use crate::game::state::GamePhase;
use crate::rooms::manager::{AppState, MAX_PLAYERS, Room};
use crate::ws::messages::{ClientMessage, PlayerInfo, ServerMessage};

pub async fn host_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_host_socket(socket, state))
}

pub async fn player_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_player_socket(socket, state))
}

async fn handle_host_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let mut room_code: Option<String> = None;

    // Forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        let Message::Text(text) = msg else { continue };
        let text: &str = &text;

        let Ok(client_msg) = serde_json::from_str::<ClientMessage>(text) else {
            warn!("Host sent invalid message format");
            let err = ServerMessage::Error {
                message: "Invalid message format".to_string(),
            };
            let _ = tx.send(serde_json::to_string(&err).unwrap());
            continue;
        };

        match client_msg {
            ClientMessage::CreateRoom { language } => {
                let code = state.create_room(language.clone()).await;
                info!(room_code = %code, language = %language, "Room created");
                if let Some(room_arc) = state.get_room(&code).await {
                    let mut room = room_arc.lock().await;
                    room.host_tx = Some(tx.clone());
                    room_code = Some(code.clone());

                    // Persist new game to DB (fire-and-forget)
                    {
                        let pool = state.pool.clone();
                        let snap = RoomSnapshot::from_room(&room);
                        tokio::spawn(async move { db::save_game(&pool, &snap).await });
                    }

                    let response = ServerMessage::RoomCreated {
                        room_code: code.clone(),
                        room_url: format!("/player/?room={}", code),
                    };
                    let _ = tx.send(serde_json::to_string(&response).unwrap());
                }
            }
            ClientMessage::StartGame => {
                if let Some(ref code) = room_code {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        if !room.phase_allows_action("start") {
                            let err = ServerMessage::Error {
                                message: "Game has already started".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        let player_count = room.players.len();

                        if player_count < 6 {
                            let err = ServerMessage::Error {
                                message: "Need at least 6 players to start".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        info!(room_code = %code, player_count, "Game starting");

                        // Assign roles
                        let roles = assign_roles(player_count);
                        for (i, player) in room.players.iter_mut().enumerate() {
                            player.role = Some(roles[i]);
                        }

                        // Transition to RoleReveal
                        room.game_state.next_phase();

                        // Send role to each player
                        for player in &room.players {
                            if let Some(role) = player.role {
                                let msg = ServerMessage::RoleAssigned {
                                    role,
                                    description_key: role.description_key().to_string(),
                                    faction: format!("{:?}", role.faction()),
                                };
                                room.send_to_player(
                                    &player.id,
                                    &serde_json::to_string(&msg).unwrap(),
                                );
                            }
                        }

                        // Notify host
                        let phase_msg = ServerMessage::PhaseChanged {
                            phase: room.game_state.phase,
                            round: room.game_state.round,
                            timer_secs: 10,
                        };
                        let _ = tx.send(serde_json::to_string(&phase_msg).unwrap());
                        room.broadcast_to_players(&serde_json::to_string(&phase_msg).unwrap());

                        // Persist role assignments + phase transition
                        {
                            let pool = state.pool.clone();
                            let snap = RoomSnapshot::from_room(&room);
                            tokio::spawn(async move {
                                db::save_phase_transition(&pool, &snap).await;
                                db::save_all_players(&pool, &snap).await;
                            });
                        }
                    }
                } else {
                    let err = ServerMessage::Error {
                        message: "No room created yet".to_string(),
                    };
                    let _ = tx.send(serde_json::to_string(&err).unwrap());
                }
            }
            ClientMessage::AdvancePhase => {
                if let Some(ref code) = room_code {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        if room.game_state.phase == GamePhase::GameOver {
                            let err = ServerMessage::Error {
                                message: "Game is already over".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }
                        if room.game_state.phase == GamePhase::Lobby {
                            let err = ServerMessage::Error {
                                message: "Game has not started yet".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        // Voting timer expired while narration is active —
                        // resolve votes instead of blindly advancing the phase.
                        if room.game_state.phase == GamePhase::Voting && room.narration_active() {
                            info!(room_code = %code, "Voting timer expired, resolving votes");
                            handle_voting_complete(&mut room, Some(state.pool.clone()));
                            continue;
                        }

                        let new_phase = room.game_state.next_phase();
                        info!(room_code = %code, phase = ?new_phase, round = room.game_state.round, "Phase advanced");

                        let timer = match new_phase {
                            GamePhase::Night => room.game_state.night_timer_secs,
                            GamePhase::Day => room.game_state.day_timer_secs,
                            GamePhase::Voting => room.game_state.voting_timer_secs,
                            _ => 0,
                        };

                        let msg = ServerMessage::PhaseChanged {
                            phase: new_phase,
                            round: room.game_state.round,
                            timer_secs: timer,
                        };
                        let json = serde_json::to_string(&msg).unwrap();
                        let _ = tx.send(json.clone());
                        room.broadcast_to_players(&json);

                        // Phase-specific narration flows
                        match new_phase {
                            GamePhase::Night => {
                                start_night_narration(&mut room, Some(state.pool.clone()))
                            }
                            GamePhase::Voting => start_voting_narration(&mut room),
                            _ => {}
                        }

                        // Persist phase transition
                        {
                            let pool = state.pool.clone();
                            let snap = RoomSnapshot::from_room(&room);
                            tokio::spawn(async move {
                                db::save_phase_transition(&pool, &snap).await;
                            });
                        }
                    }
                }
            }
            ClientMessage::NarrationNext => {
                if let Some(ref code) = room_code {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;
                        advance_and_execute_narration(&mut room, Some(state.pool.clone()));
                    }
                }
            }
            _ => {}
        }
    }

    // Host disconnected — record timestamp and notify players
    if let Some(ref code) = room_code {
        info!(room_code = %code, "Host disconnected");
        if let Some(room_arc) = state.get_room(code).await {
            let mut room = room_arc.lock().await;
            room.host_disconnected_at = Some(std::time::Instant::now());
            room.host_tx = None;

            // Notify all connected players that the host disconnected
            if room.game_state.phase != GamePhase::Lobby
                && room.game_state.phase != GamePhase::GameOver
            {
                let msg = ServerMessage::Error {
                    message: "Host disconnected — game paused. Waiting for host to reconnect..."
                        .to_string(),
                };
                room.broadcast_to_players(&serde_json::to_string(&msg).unwrap());
            }
        }
    }

    send_task.abort();
}

async fn handle_player_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let mut player_id: Option<String> = None;
    let mut player_room_code: Option<String> = None;

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        let Message::Text(text) = msg else { continue };
        let text: &str = &text;

        let Ok(client_msg) = serde_json::from_str::<ClientMessage>(text) else {
            warn!("Player sent invalid message format");
            let err = ServerMessage::Error {
                message: "Invalid message format".to_string(),
            };
            let _ = tx.send(serde_json::to_string(&err).unwrap());
            continue;
        };

        match client_msg {
            ClientMessage::JoinRoom {
                room_code,
                player_name,
            } => {
                // Validate player name
                let trimmed_name = player_name.trim().to_string();
                if trimmed_name.is_empty() || trimmed_name.len() > 20 {
                    let err = ServerMessage::Error {
                        message: "Name must be between 1 and 20 characters".to_string(),
                    };
                    let _ = tx.send(serde_json::to_string(&err).unwrap());
                    continue;
                }

                if let Some(room_arc) = state.get_room(&room_code).await {
                    let mut room = room_arc.lock().await;

                    // Check if game already started
                    if !room.phase_allows_action("join") {
                        let err = ServerMessage::Error {
                            message: "Game has already started, cannot join".to_string(),
                        };
                        let _ = tx.send(serde_json::to_string(&err).unwrap());
                        continue;
                    }

                    // Check for room capacity
                    if room.is_full() {
                        warn!(room_code = %room_code, "Player tried to join full room");
                        let err = ServerMessage::Error {
                            message: format!("Room is full (max {} players)", MAX_PLAYERS),
                        };
                        let _ = tx.send(serde_json::to_string(&err).unwrap());
                        continue;
                    }

                    // Check for duplicate names
                    if room.has_player_named(&trimmed_name) {
                        warn!(room_code = %room_code, name = %trimmed_name, "Duplicate player name rejected");
                        let err = ServerMessage::Error {
                            message: "A player with that name is already in the room".to_string(),
                        };
                        let _ = tx.send(serde_json::to_string(&err).unwrap());
                        continue;
                    }

                    let id = room.add_player(trimmed_name.clone());
                    info!(room_code = %room_code, player_id = %id, name = %trimmed_name, "Player joined");

                    // Set the player's tx
                    if let Some(player) = room.get_player_mut(&id) {
                        player.tx = Some(tx.clone());
                    }

                    player_id = Some(id.clone());
                    player_room_code = Some(room_code.clone());

                    // Confirm join to player
                    let join_msg = ServerMessage::JoinedRoom {
                        player_id: id.clone(),
                        room_code: room_code.clone(),
                    };
                    let _ = tx.send(serde_json::to_string(&join_msg).unwrap());

                    // Notify host
                    let host_msg = ServerMessage::PlayerJoined {
                        player_id: id.clone(),
                        player_name: trimmed_name,
                        player_count: room.players.len(),
                    };
                    room.send_to_host(&serde_json::to_string(&host_msg).unwrap());

                    // Send player list to host
                    let list_msg = ServerMessage::PlayerList {
                        players: room.players.iter().map(|p| p.to_info()).collect(),
                    };
                    room.send_to_host(&serde_json::to_string(&list_msg).unwrap());

                    // Persist new player
                    if let Some(player) = room.get_player(&id) {
                        let pool = state.pool.clone();
                        let game_id = room.id.clone();
                        let ps = db::PlayerSnapshot {
                            id: player.id.clone(),
                            name: player.name.clone(),
                            role: player.role,
                            alive: player.alive,
                            connected: player.connected,
                        };
                        tokio::spawn(async move {
                            db::save_player(&pool, &game_id, &ps).await;
                        });
                    }
                } else {
                    let err = ServerMessage::Error {
                        message: "Room not found".to_string(),
                    };
                    let _ = tx.send(serde_json::to_string(&err).unwrap());
                }
            }
            ClientMessage::PlayerReady { ready } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        if room.game_state.phase != GamePhase::Lobby {
                            let err = ServerMessage::Error {
                                message: "Can only toggle ready in lobby".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        let player_name = if let Some(player) = room.get_player_mut(pid) {
                            player.ready = ready;
                            player.name.clone()
                        } else {
                            continue;
                        };

                        // Notify host of ready state change
                        let update_msg = ServerMessage::PlayerReadyUpdate {
                            player_id: pid.clone(),
                            player_name,
                            ready,
                        };
                        room.send_to_host(&serde_json::to_string(&update_msg).unwrap());

                        // Send updated player list to host
                        let list_msg = ServerMessage::PlayerList {
                            players: room.players.iter().map(|p| p.to_info()).collect(),
                        };
                        room.send_to_host(&serde_json::to_string(&list_msg).unwrap());

                        // Check if all players are ready for auto-start
                        if room.all_players_ready() {
                            let countdown_msg = ServerMessage::AutoStartCountdown { seconds: 5 };
                            room.send_to_host(&serde_json::to_string(&countdown_msg).unwrap());
                            room.broadcast_to_players(
                                &serde_json::to_string(&countdown_msg).unwrap(),
                            );
                        } else if !ready {
                            // Player un-readied — cancel any active countdown
                            let cancel_msg = ServerMessage::AutoStartCancelled;
                            room.send_to_host(&serde_json::to_string(&cancel_msg).unwrap());
                            room.broadcast_to_players(&serde_json::to_string(&cancel_msg).unwrap());
                        }
                    }
                }
            }
            ClientMessage::NightAction {
                target_id,
                secondary_target_id,
            } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        // Validate phase
                        if !room.phase_allows_action("night_action") {
                            let err = ServerMessage::Error {
                                message:
                                    "Night actions can only be performed during the night phase"
                                        .to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        // Prevent duplicate submissions
                        if room.night_actions.iter().any(|a| a.actor_id == *pid) {
                            let err = ServerMessage::Error {
                                message: "You have already submitted your night action".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        if let Some(player) = room.get_player(pid) {
                            if !player.alive {
                                let err = ServerMessage::Error {
                                    message: "Dead players cannot perform actions".to_string(),
                                };
                                let _ = tx.send(serde_json::to_string(&err).unwrap());
                                continue;
                            }
                            if let Some(role) = player.role {
                                info!(room_code = %code, player_id = %pid, role = ?role, "Night action submitted");
                                room.night_actions.push(crate::game::phases::NightAction {
                                    actor_id: pid.clone(),
                                    role,
                                    target_id: target_id.clone(),
                                    secondary_target_id,
                                });

                                // Persist night action event
                                {
                                    let pool = state.pool.clone();
                                    let game_id = room.id.clone();
                                    let round = room.game_state.round;
                                    let phase = room.game_state.phase;
                                    let data = serde_json::json!({
                                        "actor_id": pid,
                                        "role": format!("{:?}", role),
                                        "target_id": target_id,
                                    });
                                    tokio::spawn(async move {
                                        db::save_game_event(
                                            &pool,
                                            &game_id,
                                            round,
                                            phase,
                                            "night_action",
                                            &data,
                                        )
                                        .await;
                                    });
                                }
                            }
                        }
                    }
                }
            }
            ClientMessage::Vote { target_id } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        // Validate phase
                        if !room.phase_allows_action("vote") {
                            let err = ServerMessage::Error {
                                message: "Voting can only be done during the voting phase"
                                    .to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        // Check player is alive
                        if let Some(player) = room.get_player(pid) {
                            if !player.alive {
                                let err = ServerMessage::Error {
                                    message: "Dead players cannot vote".to_string(),
                                };
                                let _ = tx.send(serde_json::to_string(&err).unwrap());
                                continue;
                            }
                        }

                        info!(room_code = %code, player_id = %pid, "Vote cast");
                        room.votes.insert(pid.clone(), target_id.clone());

                        // Persist vote event
                        {
                            let pool = state.pool.clone();
                            let game_id = room.id.clone();
                            let round = room.game_state.round;
                            let phase = room.game_state.phase;
                            let data = serde_json::json!({
                                "voter_id": pid,
                                "target_id": target_id,
                            });
                            tokio::spawn(async move {
                                db::save_game_event(&pool, &game_id, round, phase, "vote", &data)
                                    .await;
                            });
                        }

                        // Broadcast vote update
                        let vote_msg = ServerMessage::VoteUpdate {
                            votes: room
                                .votes
                                .iter()
                                .map(|(voter_id, target)| {
                                    let voter_name = room
                                        .get_player(voter_id)
                                        .map(|p| p.name.clone())
                                        .unwrap_or_default();
                                    crate::ws::messages::VoteInfo {
                                        voter_id: voter_id.clone(),
                                        voter_name,
                                        target_id: target.clone(),
                                    }
                                })
                                .collect(),
                            timer_remaining: 0,
                        };
                        let json = serde_json::to_string(&vote_msg).unwrap();
                        room.send_to_host(&json);
                        room.broadcast_to_players(&json);

                        // If all alive players have voted, resolve immediately
                        let alive_count = room.alive_players().len();
                        if room.votes.len() >= alive_count {
                            info!(room_code = %code, "All alive players voted, resolving");
                            handle_voting_complete(&mut room, Some(state.pool.clone()));
                        }
                    }
                }
            }
            ClientMessage::ReadyToVote { ready } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;
                        if room.game_state.phase != GamePhase::Day {
                            continue;
                        }
                        if let Some(player) = room.get_player(pid) {
                            let name = player.name.clone();
                            // Track ready-to-vote in votes map (None = ready but no vote yet)
                            if ready {
                                room.votes.insert(pid.clone(), None);
                            } else {
                                room.votes.remove(pid);
                            }
                            let update = ServerMessage::ReadyToVoteUpdate {
                                player_id: pid.clone(),
                                player_name: name,
                                ready,
                            };
                            let json = serde_json::to_string(&update).unwrap();
                            room.send_to_host(&json);

                            // Check if all alive players are ready to vote
                            let alive = room.alive_players();
                            let alive_count = alive.len();
                            let ready_count = alive
                                .iter()
                                .filter(|p| room.votes.contains_key(&p.id))
                                .count();
                            if ready_count >= alive_count && alive_count >= 2 {
                                info!(room_code = %code, "All alive players ready to vote, advancing");
                                room.votes.clear();
                                let all_ready = ServerMessage::AllReadyToVote;
                                let json = serde_json::to_string(&all_ready).unwrap();
                                room.send_to_host(&json);
                                room.broadcast_to_players(&json);
                            }
                        }
                    }
                }
            }
            ClientMessage::Reconnect {
                player_id: pid,
                room_code: code,
            } => {
                info!(room_code = %code, player_id = %pid, "Player reconnecting");
                if let Some(room_arc) = state.get_room(&code).await {
                    let mut room = room_arc.lock().await;

                    let player_exists = room.get_player(&pid).is_some();
                    if !player_exists {
                        warn!(room_code = %code, player_id = %pid, "Reconnect failed: player not found");
                        let err = ServerMessage::Error {
                            message: "Player not found in room".to_string(),
                        };
                        let _ = tx.send(serde_json::to_string(&err).unwrap());
                        continue;
                    }

                    // Re-attach WebSocket sender and mark connected
                    if let Some(player) = room.get_player_mut(&pid) {
                        player.tx = Some(tx.clone());
                        player.connected = true;
                        player.disconnected_at = None;
                    }

                    // Track the reconnected player locally
                    player_id = Some(pid.clone());
                    player_room_code = Some(code.clone());

                    let snapshot = room.get_game_snapshot();

                    // Gather player-specific info
                    let player = room.get_player(&pid).unwrap();
                    let role = player.role;
                    let description_key = role.map(|r| r.description_key().to_string());
                    let faction = role.map(|r| format!("{:?}", r.faction()));
                    let player_name = player.name.clone();
                    let player_alive = player.alive;

                    // Include vote tally if in voting phase
                    let votes = if snapshot.phase == GamePhase::Voting {
                        Some(
                            room.votes
                                .iter()
                                .map(|(voter_id, target)| {
                                    let voter_name = room
                                        .get_player(voter_id)
                                        .map(|p| p.name.clone())
                                        .unwrap_or_default();
                                    crate::ws::messages::VoteInfo {
                                        voter_id: voter_id.clone(),
                                        voter_name,
                                        target_id: target.clone(),
                                    }
                                })
                                .collect(),
                        )
                    } else {
                        None
                    };

                    // Send reconnect state to the player
                    let reconnect_msg = ServerMessage::ReconnectState {
                        player_id: pid.clone(),
                        room_code: code.clone(),
                        phase: snapshot.phase,
                        round: snapshot.round,
                        alive_players: snapshot.alive_players,
                        role,
                        description_key,
                        faction,
                        votes,
                    };
                    let _ = tx.send(serde_json::to_string(&reconnect_msg).unwrap());

                    // If night phase and player is being waited for, re-send wake + prompt
                    if snapshot.phase == GamePhase::Night && player_alive {
                        if room.narration_ack_pending.contains(&pid) {
                            // Player is currently expected to act — re-send WakeUp + prompt
                            if let Some(r) = role {
                                let wake_msg = ServerMessage::WakeUp {
                                    role: role_display_name(r).to_string(),
                                    instruction: role_instruction(r).to_string(),
                                };
                                let _ = tx.send(serde_json::to_string(&wake_msg).unwrap());

                                let alive_targets: Vec<PlayerInfo> = room
                                    .alive_players()
                                    .iter()
                                    .filter(|p| p.id != pid)
                                    .map(|p| p.to_info())
                                    .collect();
                                let prompt = ServerMessage::NightActionPrompt {
                                    available_targets: alive_targets,
                                };
                                let _ = tx.send(serde_json::to_string(&prompt).unwrap());
                            }
                        }
                    }

                    info!(room_code = %code, player_id = %pid, player_name = %player_name, "Player reconnected");

                    // Notify host
                    let host_msg = ServerMessage::PlayerReconnected {
                        player_id: pid,
                        player_name,
                    };
                    room.send_to_host(&serde_json::to_string(&host_msg).unwrap());

                    // Send updated player list to host
                    let list_msg = ServerMessage::PlayerList {
                        players: room.players.iter().map(|p| p.to_info()).collect(),
                    };
                    room.send_to_host(&serde_json::to_string(&list_msg).unwrap());
                } else {
                    let err = ServerMessage::Error {
                        message: "Room not found".to_string(),
                    };
                    let _ = tx.send(serde_json::to_string(&err).unwrap());
                }
            }
            ClientMessage::NarrationAck => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        if !room.narration_ack_pending.remove(pid) {
                            continue; // not waiting for this player
                        }

                        info!(room_code = %code, player_id = %pid, "Narration ack received");

                        if room.narration_ack_pending.is_empty() {
                            // All expected acks received — advance narration
                            advance_and_execute_narration(&mut room, Some(state.pool.clone()));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Player disconnected — record timestamp for reconnection tracking
    if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
        info!(room_code = %code, player_id = %pid, "Player disconnected");
        if let Some(room_arc) = state.get_room(code).await {
            let mut room = room_arc.lock().await;
            if let Some(player) = room.get_player_mut(pid) {
                player.connected = false;
                player.disconnected_at = Some(std::time::Instant::now());
                let name = player.name.clone();
                let msg = ServerMessage::PlayerLeft {
                    player_id: pid.clone(),
                    player_name: name,
                };
                room.send_to_host(&serde_json::to_string(&msg).unwrap());
            }
        }
    }

    send_task.abort();
}

/// Legacy fallback — sends night prompts to all players at once (bypasses narration).
#[allow(dead_code)]
fn send_night_prompts(room: &Room) {
    let alive_targets: Vec<PlayerInfo> = room.alive_players().iter().map(|p| p.to_info()).collect();

    for player in room.alive_players() {
        if let Some(role) = player.role {
            if role.has_night_action() {
                let prompt = ServerMessage::NightActionPrompt {
                    available_targets: alive_targets
                        .iter()
                        .filter(|t| t.id != player.id)
                        .cloned()
                        .collect(),
                };
                room.send_to_player(&player.id, &serde_json::to_string(&prompt).unwrap());
            }
        }
    }
}

/// Build the night narration script and begin executing it.
fn start_night_narration(room: &mut Room, pool: Option<SqlitePool>) {
    let alive_players: Vec<(String, Role)> = room
        .alive_players()
        .iter()
        .filter_map(|p| p.role.map(|r| (p.id.clone(), r)))
        .collect();
    let script = build_night_script(&alive_players);
    room.set_narration_queue(script);

    // Execute the first step
    if let Some(step) = room.advance_narration() {
        execute_narration_step(room, &step);
    } else {
        // Empty script (e.g. no night roles) — resolve immediately
        resolve_night_and_advance_to_dawn(room, pool);
    }
}

/// Advance to the next narration step and execute it.
/// If no steps remain, handle phase-specific completion.
fn advance_and_execute_narration(room: &mut Room, pool: Option<SqlitePool>) {
    if let Some(step) = room.advance_narration() {
        execute_narration_step(room, &step);
    } else {
        on_narration_complete(room, pool);
    }
}

/// Called when the last narration step has been completed.
fn on_narration_complete(room: &mut Room, pool: Option<SqlitePool>) {
    match room.game_state.phase {
        GamePhase::Night => resolve_night_and_advance_to_dawn(room, pool),
        GamePhase::Dawn => transition_dawn_to_day(room, pool),
        GamePhase::Voting => transition_voting_to_execution(room, pool),
        _ => {}
    }
}

/// Send a narration step to the host and handle side effects (wake/sleep/prompt).
fn execute_narration_step(room: &mut Room, step: &crate::game::narrator::NarrationStep) {
    // Find player IDs targeted by this step's role
    let target_player_ids: Vec<String> = if let Some(ref target_role) = step.target_role {
        room.alive_players()
            .iter()
            .filter(|p| p.role.and_then(canonical_wake_role) == Some(*target_role))
            .map(|p| p.id.clone())
            .collect()
    } else {
        Vec::new()
    };

    // Send NarrationStep to host
    let host_msg = ServerMessage::NarrationStep {
        key: step.key.clone(),
        text: step.text.clone(),
        audio_file: step.audio_file.clone(),
        wait_for: step.wait_for.clone(),
        target_player_id: target_player_ids.first().cloned(),
    };
    room.send_to_host(&serde_json::to_string(&host_msg).unwrap());

    // Handle role-specific side effects
    if step.target_role.is_some() {
        if step.key.ends_with("_wakes") {
            // Wake up targeted players
            for pid in &target_player_ids {
                if let Some(player) = room.get_player(pid) {
                    if let Some(role) = player.role {
                        let wake_msg = ServerMessage::WakeUp {
                            role: role_display_name(role).to_string(),
                            instruction: role_instruction(role).to_string(),
                        };
                        room.send_to_player(pid, &serde_json::to_string(&wake_msg).unwrap());
                    }
                }
            }
        } else if step.wait_for == WaitFor::PlayerAction {
            // Send night action prompts and wait for acks
            let alive_targets: Vec<PlayerInfo> =
                room.alive_players().iter().map(|p| p.to_info()).collect();
            for pid in &target_player_ids {
                let prompt = ServerMessage::NightActionPrompt {
                    available_targets: alive_targets
                        .iter()
                        .filter(|t| t.id != *pid)
                        .cloned()
                        .collect(),
                };
                room.send_to_player(pid, &serde_json::to_string(&prompt).unwrap());
            }
            room.narration_ack_pending = target_player_ids.into_iter().collect();
        } else if step.key.ends_with("_sleeps") {
            // Put targeted players back to sleep
            let sleep_msg = ServerMessage::GoToSleep;
            let json = serde_json::to_string(&sleep_msg).unwrap();
            for pid in &target_player_ids {
                room.send_to_player(pid, &json);
            }
        }
    }
}

/// Helper: spawn persistence for a phase transition + player state update.
fn spawn_persist_phase(pool: &Option<SqlitePool>, room: &Room) {
    if let Some(pool) = pool.clone() {
        let snap = RoomSnapshot::from_room(room);
        tokio::spawn(async move {
            db::save_phase_transition(&pool, &snap).await;
            db::save_all_players(&pool, &snap).await;
        });
    }
}

/// Resolve all night actions, apply results, and transition to Dawn.
fn resolve_night_and_advance_to_dawn(room: &mut Room, pool: Option<SqlitePool>) {
    let alive_map: HashMap<String, Role> = room
        .alive_players()
        .iter()
        .filter_map(|p| p.role.map(|r| (p.id.clone(), r)))
        .collect();

    let result = resolve_night(&room.night_actions, &alive_map);

    // Send investigation results before applying deaths
    for (target_id, appears_guilty) in &result.investigated {
        let target_name = room
            .get_player(target_id)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        for action in &room.night_actions {
            if action.role == Role::Detective
                && action.target_id.as_deref() == Some(target_id.as_str())
            {
                let inv_msg = ServerMessage::InvestigationResult {
                    target_name: target_name.clone(),
                    appears_guilty: *appears_guilty,
                };
                room.send_to_player(&action.actor_id, &serde_json::to_string(&inv_msg).unwrap());
            }
        }
    }

    // Apply deaths
    let killed_ids = result.killed.clone();
    for killed_id in &killed_ids {
        if let Some(player) = room.get_player_mut(killed_id) {
            player.alive = false;
        }
    }

    // Persist night resolution events (kills, heals)
    if let Some(ref p) = pool {
        let p = p.clone();
        let game_id = room.id.clone();
        let round = room.game_state.round;
        let phase = room.game_state.phase;
        let killed = result.killed.clone();
        let healed = result.healed.clone();
        tokio::spawn(async move {
            for kid in &killed {
                let data = serde_json::json!({ "player_id": kid });
                db::save_game_event(&p, &game_id, round, phase, "kill", &data).await;
            }
            for hid in &healed {
                let data = serde_json::json!({ "player_id": hid });
                db::save_game_event(&p, &game_id, round, phase, "heal", &data).await;
            }
        });
    }

    // Send night results to host
    let killed_info: Vec<PlayerInfo> = killed_ids
        .iter()
        .filter_map(|id| room.get_player(id).map(|p| p.to_info()))
        .collect();
    let night_results = ServerMessage::NightResults {
        killed: killed_info,
        saved: !result.healed.is_empty(),
        events: Vec::new(),
    };
    room.send_to_host(&serde_json::to_string(&night_results).unwrap());

    // Clear state
    room.night_actions.clear();
    room.narration_ack_pending.clear();

    // Transition Night → Dawn
    let new_phase = room.game_state.next_phase();
    info!(phase = ?new_phase, round = room.game_state.round, "Night resolved, advancing to Dawn");

    let phase_msg = ServerMessage::PhaseChanged {
        phase: new_phase,
        round: room.game_state.round,
        timer_secs: 0,
    };
    let json = serde_json::to_string(&phase_msg).unwrap();
    room.send_to_host(&json);
    room.broadcast_to_players(&json);

    // Persist phase transition + player deaths
    spawn_persist_phase(&pool, room);

    // Send alive player list (reflects deaths)
    let alive_msg = ServerMessage::AlivePlayerList {
        players: room.players.iter().map(|p| p.to_info()).collect(),
    };
    let alive_json = serde_json::to_string(&alive_msg).unwrap();
    room.send_to_host(&alive_json);
    room.broadcast_to_players(&alive_json);

    // Start dawn narration with victim names
    let death_names: Vec<String> = killed_ids
        .iter()
        .filter_map(|id| room.get_player(id).map(|p| p.name.clone()))
        .collect();
    let dawn_script = build_dawn_script(&death_names);
    room.set_narration_queue(dawn_script);
    if let Some(step) = room.advance_narration() {
        execute_narration_step(room, &step);
    } else {
        // Empty script — go straight to Day
        transition_dawn_to_day(room, pool);
    }
}

/// Transition Dawn → Day with discussion timer.
fn transition_dawn_to_day(room: &mut Room, pool: Option<SqlitePool>) {
    room.clear_narration();
    let new_phase = room.game_state.next_phase(); // Dawn → Day
    info!(phase = ?new_phase, round = room.game_state.round, "Dawn narration complete, advancing to Day");

    let timer = room.game_state.day_timer_secs;
    let phase_msg = ServerMessage::PhaseChanged {
        phase: new_phase,
        round: room.game_state.round,
        timer_secs: timer,
    };
    let json = serde_json::to_string(&phase_msg).unwrap();
    room.send_to_host(&json);
    room.broadcast_to_players(&json);

    spawn_persist_phase(&pool, room);
}

/// Build the voting narration script and begin executing it.
fn start_voting_narration(room: &mut Room) {
    let script = build_voting_script();
    room.set_narration_queue(script);

    if let Some(step) = room.advance_narration() {
        execute_narration_step(room, &step);
    }
    // If empty (shouldn't be), voting just proceeds without narration
}

/// Resolve votes, send results, and advance narration to the final step.
fn handle_voting_complete(room: &mut Room, pool: Option<SqlitePool>) {
    resolve_and_send_vote_result(room, &pool);

    // Advance narration past the current "cast_votes" step to "votes_are_in"
    if room.narration_active() {
        // Skip forward to the "votes_are_in" step
        loop {
            if let Some(step) = room.advance_narration() {
                if step.key == "voting.votes_are_in" {
                    execute_narration_step(room, &step);
                    return;
                }
            } else {
                break;
            }
        }
    }

    // No narration left — transition directly
    transition_voting_to_execution(room, pool);
}

/// Transition Voting → Execution.
fn transition_voting_to_execution(room: &mut Room, pool: Option<SqlitePool>) {
    room.clear_narration();
    let new_phase = room.game_state.next_phase(); // Voting → Execution
    info!(phase = ?new_phase, round = room.game_state.round, "Voting complete, advancing to Execution");

    let phase_msg = ServerMessage::PhaseChanged {
        phase: new_phase,
        round: room.game_state.round,
        timer_secs: 0,
    };
    let json = serde_json::to_string(&phase_msg).unwrap();
    room.send_to_host(&json);
    room.broadcast_to_players(&json);

    // Send alive player list (reflects lynched player)
    let alive_msg = ServerMessage::AlivePlayerList {
        players: room.players.iter().map(|p| p.to_info()).collect(),
    };
    let alive_json = serde_json::to_string(&alive_msg).unwrap();
    room.send_to_host(&alive_json);
    room.broadcast_to_players(&alive_json);

    spawn_persist_phase(&pool, room);
}

/// Count votes, determine the outcome, mark the lynched player dead, and broadcast results.
fn resolve_and_send_vote_result(room: &mut Room, pool: &Option<SqlitePool>) {
    // Players who didn't vote, vote for themselves
    let alive_ids: Vec<String> = room.alive_players().iter().map(|p| p.id.clone()).collect();
    for pid in &alive_ids {
        if !room.votes.contains_key(pid) {
            room.votes.insert(pid.clone(), Some(pid.clone()));
        }
    }

    let mut vote_counts: HashMap<String, usize> = HashMap::new();
    for target in room.votes.values().flatten() {
        *vote_counts.entry(target.clone()).or_insert(0) += 1;
    }

    let max_votes = vote_counts.values().max().copied().unwrap_or(0);
    let top_targets: Vec<String> = vote_counts
        .iter()
        .filter(|(_, count)| **count == max_votes && **count > 0)
        .map(|(id, _)| id.clone())
        .collect();

    // Resolve ties: Godfather's vote is the tie-breaker, otherwise random
    let lynch_target = if top_targets.len() == 1 {
        Some(top_targets[0].clone())
    } else if top_targets.len() > 1 {
        // Find the alive Godfather (or first alive Mafioso)
        let godfather_vote = room
            .players
            .iter()
            .filter(|p| p.alive)
            .find(|p| p.role == Some(crate::game::roles::Role::Godfather))
            .or_else(|| {
                room.players
                    .iter()
                    .filter(|p| p.alive)
                    .find(|p| p.role == Some(crate::game::roles::Role::Mafioso))
            })
            .and_then(|p| room.votes.get(&p.id).cloned().flatten());

        // If the mafia leader voted for one of the tied targets, that one dies
        if let Some(ref gf_target) = godfather_vote {
            if top_targets.contains(gf_target) {
                Some(gf_target.clone())
            } else {
                // Mafia leader voted for someone not in the tie — random
                let idx = rand::rng().random_range(0..top_targets.len());
                Some(top_targets[idx].clone())
            }
        } else {
            // No alive mafia leader — random pick among tied
            let idx = rand::rng().random_range(0..top_targets.len());
            Some(top_targets[idx].clone())
        }
    } else {
        None
    };

    let (target_info, was_lynched) = if let Some(target_id) = lynch_target {
        let target_name = room
            .get_player(&target_id)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        if let Some(player) = room.get_player_mut(&target_id) {
            player.alive = false;
        }

        // Persist lynch event
        if let Some(p) = pool {
            let p = p.clone();
            let game_id = room.id.clone();
            let round = room.game_state.round;
            let phase = room.game_state.phase;
            let data = serde_json::json!({
                "lynched_id": target_id,
                "lynched_name": target_name,
                "vote_counts": vote_counts.iter().map(|(k, v)| (k.clone(), *v)).collect::<HashMap<String, usize>>(),
            });
            tokio::spawn(async move {
                db::save_game_event(&p, &game_id, round, phase, "lynch", &data).await;
            });
        }

        (
            Some(PlayerInfo {
                id: target_id.clone(),
                name: target_name,
                alive: false,
                ready: false,
            }),
            true,
        )
    } else {
        (None, false)
    };

    let result_msg = ServerMessage::VoteResult {
        target: target_info,
        was_lynched,
    };
    let json = serde_json::to_string(&result_msg).unwrap();
    room.send_to_host(&json);
    room.broadcast_to_players(&json);

    room.votes.clear();
}
