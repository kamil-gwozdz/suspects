use serde::{Deserialize, Serialize};
use crate::game::roles::Role;
use crate::game::state::GamePhase;

/// Messages sent from clients (host or player) to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
#[serde(rename_all = "snake_case")]
pub enum ClientMessage {
    /// Host creates a new room
    CreateRoom { language: String },
    /// Player joins a room
    JoinRoom { room_code: String, player_name: String },
    /// Host starts the game
    StartGame,
    /// Player submits night action
    NightAction { target_id: Option<String>, secondary_target_id: Option<String> },
    /// Player casts a vote during day
    Vote { target_id: Option<String> },
    /// Player sends a chat message (mafia night chat)
    Chat { message: String },
    /// Host advances to next phase manually
    AdvancePhase,
    /// Player reconnects
    Reconnect { player_id: String, room_code: String },
}

/// Messages sent from the server to clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
#[serde(rename_all = "snake_case")]
pub enum ServerMessage {
    /// Room created successfully (sent to host)
    RoomCreated { room_code: String, room_url: String },
    /// Player joined (broadcast to host)
    PlayerJoined { player_id: String, player_name: String, player_count: usize },
    /// Player left/disconnected
    PlayerLeft { player_id: String, player_name: String },
    /// Joined room confirmation (sent to player)
    JoinedRoom { player_id: String, room_code: String },
    /// Phase changed
    PhaseChanged { phase: GamePhase, round: u32, timer_secs: u32 },
    /// Role assignment (sent privately to each player)
    RoleAssigned { role: Role, description_key: String, faction: String },
    /// Night action prompt (sent to players with night actions)
    NightActionPrompt { available_targets: Vec<PlayerInfo> },
    /// Night results (sent to host for display)
    NightResults { killed: Vec<PlayerInfo>, saved: bool, events: Vec<String> },
    /// Investigation result (sent privately to Detective)
    InvestigationResult { target_name: String, appears_guilty: bool },
    /// Vote update (broadcast)
    VoteUpdate { votes: Vec<VoteInfo>, timer_remaining: u32 },
    /// Vote result
    VoteResult { target: Option<PlayerInfo>, was_lynched: bool },
    /// Game over
    GameOver { winner: String, player_roles: Vec<PlayerRoleReveal> },
    /// Chat message (mafia chat)
    ChatMessage { sender_name: String, message: String },
    /// Error
    Error { message: String },
    /// Player list update
    PlayerList { players: Vec<PlayerInfo> },
    /// Alive players list
    AlivePlayerList { players: Vec<PlayerInfo> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerInfo {
    pub id: String,
    pub name: String,
    pub alive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteInfo {
    pub voter_id: String,
    pub voter_name: String,
    pub target_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerRoleReveal {
    pub player_id: String,
    pub player_name: String,
    pub role: Role,
    pub alive: bool,
}
