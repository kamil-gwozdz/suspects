use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use std::collections::HashMap;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{info, warn, error};

use crate::rooms::manager::{AppState, Room, MAX_PLAYERS};
use crate::ws::messages::{ClientMessage, ServerMessage, PlayerInfo};
use crate::game::scaling::assign_roles;
use crate::game::roles::{Faction, Role};
use crate::game::state::GamePhase;
use crate::game::narrator::{
    build_night_script, canonical_wake_role, role_display_name, role_instruction, WaitFor,
};
use crate::game::phases::resolve_night;

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
            let err = ServerMessage::Error { message: "Invalid message format".to_string() };
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
                                room.send_to_player(&player.id, &serde_json::to_string(&msg).unwrap());
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

                        // Start narration-driven night flow
                        if new_phase == GamePhase::Night {
                            start_night_narration(&mut room);
                        }
                    }
                }
            }
            ClientMessage::NarrationNext => {
                if let Some(ref code) = room_code {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;
                        advance_and_execute_narration(&mut room);
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
                    message: "Host disconnected — game paused. Waiting for host to reconnect...".to_string(),
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
            let err = ServerMessage::Error { message: "Invalid message format".to_string() };
            let _ = tx.send(serde_json::to_string(&err).unwrap());
            continue;
        };

        match client_msg {
            ClientMessage::JoinRoom { room_code, player_name } => {
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
                        player_id: id,
                        player_name: trimmed_name,
                        player_count: room.players.len(),
                    };
                    room.send_to_host(&serde_json::to_string(&host_msg).unwrap());

                    // Send player list to host
                    let list_msg = ServerMessage::PlayerList {
                        players: room.players.iter().map(|p| p.to_info()).collect(),
                    };
                    room.send_to_host(&serde_json::to_string(&list_msg).unwrap());
                } else {
                    let err = ServerMessage::Error { message: "Room not found".to_string() };
                    let _ = tx.send(serde_json::to_string(&err).unwrap());
                }
            }
            ClientMessage::NightAction { target_id, secondary_target_id } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;

                        // Validate phase
                        if !room.phase_allows_action("night_action") {
                            let err = ServerMessage::Error {
                                message: "Night actions can only be performed during the night phase".to_string(),
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
                                    target_id,
                                    secondary_target_id,
                                });
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
                                message: "Voting can only be done during the voting phase".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        // Prevent duplicate votes
                        if room.votes.contains_key(pid) {
                            let err = ServerMessage::Error {
                                message: "You have already cast your vote".to_string(),
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
                        room.votes.insert(pid.clone(), target_id);

                        // Broadcast vote update
                        let vote_msg = ServerMessage::VoteUpdate {
                            votes: room.votes.iter().map(|(voter_id, target)| {
                                let voter_name = room.get_player(voter_id)
                                    .map(|p| p.name.clone())
                                    .unwrap_or_default();
                                crate::ws::messages::VoteInfo {
                                    voter_id: voter_id.clone(),
                                    voter_name,
                                    target_id: target.clone(),
                                }
                            }).collect(),
                            timer_remaining: 0,
                        };
                        let json = serde_json::to_string(&vote_msg).unwrap();
                        room.send_to_host(&json);
                        room.broadcast_to_players(&json);
                    }
                }
            }
            ClientMessage::Chat { message } => {
                if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
                    if let Some(room_arc) = state.get_room(code).await {
                        let room = room_arc.lock().await;

                        // Validate phase
                        if !room.phase_allows_action("chat") {
                            let err = ServerMessage::Error {
                                message: "Chat is only available during the night phase".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

                        // Validate message length
                        if message.trim().is_empty() || message.len() > 500 {
                            continue;
                        }

                        if let Some(player) = room.get_player(pid) {
                            // Only mafia can chat during night
                            if let Some(role) = player.role {
                                if role.faction() == Faction::Mafia {
                                    let chat_msg = ServerMessage::ChatMessage {
                                        sender_name: player.name.clone(),
                                        message,
                                    };
                                    let json = serde_json::to_string(&chat_msg).unwrap();
                                    // Send to all mafia + spy
                                    for p in &room.players {
                                        if let Some(r) = p.role {
                                            if r.faction() == Faction::Mafia || r == crate::game::roles::Role::Spy {
                                                room.send_to_player(&p.id, &json);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            ClientMessage::Reconnect { player_id: pid, room_code: code } => {
                info!(room_code = %code, player_id = %pid, "Player reconnecting");
                if let Some(room_arc) = state.get_room(&code).await {
                    let mut room = room_arc.lock().await;

                    let player_exists = room.get_player(&pid).is_some();
                    if !player_exists {
                        warn!(room_code = %code, player_id = %pid, "Reconnect failed: player not found");
                        let err = ServerMessage::Error { message: "Player not found in room".to_string() };
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
                        Some(room.votes.iter().map(|(voter_id, target)| {
                            let voter_name = room.get_player(voter_id)
                                .map(|p| p.name.clone())
                                .unwrap_or_default();
                            crate::ws::messages::VoteInfo {
                                voter_id: voter_id.clone(),
                                voter_name,
                                target_id: target.clone(),
                            }
                        }).collect())
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
                    if snapshot.phase == GamePhase::Night
                        && player_alive
                    {
                        if room.narration_ack_pending.contains(&pid) {
                            // Player is currently expected to act — re-send WakeUp + prompt
                            if let Some(r) = role {
                                let wake_msg = ServerMessage::WakeUp {
                                    role: role_display_name(r).to_string(),
                                    instruction: role_instruction(r).to_string(),
                                };
                                let _ = tx.send(serde_json::to_string(&wake_msg).unwrap());

                                let alive_targets: Vec<PlayerInfo> = room.alive_players()
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
                    let err = ServerMessage::Error { message: "Room not found".to_string() };
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
                            advance_and_execute_narration(&mut room);
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

fn send_night_prompts(room: &Room) {
    let alive_targets: Vec<crate::ws::messages::PlayerInfo> = room.alive_players()
        .iter()
        .map(|p| p.to_info())
        .collect();

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
