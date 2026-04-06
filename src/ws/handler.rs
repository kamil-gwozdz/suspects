use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::rooms::manager::{AppState, Room};
use crate::ws::messages::{ClientMessage, ServerMessage};
use crate::game::scaling::assign_roles;
use crate::game::roles::Faction;

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
            let err = ServerMessage::Error { message: "Invalid message format".to_string() };
            let _ = tx.send(serde_json::to_string(&err).unwrap());
            continue;
        };

        match client_msg {
            ClientMessage::CreateRoom { language } => {
                let code = state.create_room(language).await;
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
                        let player_count = room.players.len();

                        if player_count < 6 {
                            let err = ServerMessage::Error {
                                message: "Need at least 6 players to start".to_string(),
                            };
                            let _ = tx.send(serde_json::to_string(&err).unwrap());
                            continue;
                        }

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
                }
            }
            ClientMessage::AdvancePhase => {
                if let Some(ref code) = room_code {
                    if let Some(room_arc) = state.get_room(code).await {
                        let mut room = room_arc.lock().await;
                        let new_phase = room.game_state.next_phase();

                        let timer = match new_phase {
                            crate::game::state::GamePhase::Night => room.game_state.night_timer_secs,
                            crate::game::state::GamePhase::Day => room.game_state.day_timer_secs,
                            crate::game::state::GamePhase::Voting => room.game_state.voting_timer_secs,
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

                        // Send night action prompts if entering night
                        if new_phase == crate::game::state::GamePhase::Night {
                            send_night_prompts(&room);
                        }
                    }
                }
            }
            _ => {}
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
            let err = ServerMessage::Error { message: "Invalid message format".to_string() };
            let _ = tx.send(serde_json::to_string(&err).unwrap());
            continue;
        };

        match client_msg {
            ClientMessage::JoinRoom { room_code, player_name } => {
                if let Some(room_arc) = state.get_room(&room_code).await {
                    let mut room = room_arc.lock().await;
                    let id = room.add_player(player_name.clone());

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
                        player_name,
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
                        if let Some(player) = room.get_player(pid) {
                            if let Some(role) = player.role {
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
                if let Some(room_arc) = state.get_room(&code).await {
                    let mut room = room_arc.lock().await;

                    let player_exists = room.get_player(&pid).is_some();
                    if !player_exists {
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
                    let votes = if snapshot.phase == crate::game::state::GamePhase::Voting {
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

                    // If night phase and player has night action, send prompt
                    if snapshot.phase == crate::game::state::GamePhase::Night
                        && player_alive
                    {
                        if let Some(r) = role {
                            if r.has_night_action() {
                                let alive_targets: Vec<crate::ws::messages::PlayerInfo> = room.alive_players()
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
            _ => {}
        }
    }

    // Player disconnected — record timestamp for reconnection tracking
    if let (Some(pid), Some(code)) = (&player_id, &player_room_code) {
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
