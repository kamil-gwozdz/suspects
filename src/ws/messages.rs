use crate::game::minigames::MiniGameType;
use crate::game::narrator::WaitFor;
use crate::game::roles::Role;
use crate::game::state::GamePhase;
use serde::{Deserialize, Serialize};

/// Messages sent from clients (host or player) to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
#[serde(rename_all = "snake_case")]
pub enum ClientMessage {
    /// Host creates a new room
    CreateRoom { language: String },
    /// Player joins a room
    JoinRoom {
        room_code: String,
        player_name: String,
    },
    /// Host starts the game
    StartGame,
    /// Player submits night action
    NightAction {
        target_id: Option<String>,
        secondary_target_id: Option<String>,
    },
    /// Player casts a vote during day
    Vote { target_id: Option<String> },
    /// Player toggles ready state
    PlayerReady { ready: bool },
    /// Player signals ready to move to voting phase
    ReadyToVote { ready: bool },
    /// Host advances to next phase manually
    AdvancePhase,
    /// Player reconnects
    Reconnect {
        player_id: String,
        room_code: String,
    },
    /// Player responds to a mini-game prompt
    MiniGameAction {
        game_type: MiniGameType,
        action: serde_json::Value,
    },
    /// Player signals they are done with their night action
    NarrationAck,
    /// Host signals ready for next narration step
    NarrationNext,
}

/// Messages sent from the server to clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
#[serde(rename_all = "snake_case")]
pub enum ServerMessage {
    /// Room created successfully (sent to host)
    RoomCreated { room_code: String, room_url: String },
    /// Player joined (broadcast to host)
    PlayerJoined {
        player_id: String,
        player_name: String,
        player_count: usize,
    },
    /// Player left/disconnected
    PlayerLeft {
        player_id: String,
        player_name: String,
    },
    /// Player reconnected (sent to host)
    PlayerReconnected {
        player_id: String,
        player_name: String,
    },
    /// Joined room confirmation (sent to player)
    JoinedRoom {
        player_id: String,
        room_code: String,
    },
    /// Phase changed
    PhaseChanged {
        phase: GamePhase,
        round: u32,
        timer_secs: u32,
    },
    /// Role assignment (sent privately to each player)
    RoleAssigned {
        role: Role,
        description_key: String,
        faction: String,
    },
    /// Night action prompt (sent to players with night actions)
    NightActionPrompt { available_targets: Vec<PlayerInfo> },
    /// Night results (sent to host for display)
    NightResults {
        killed: Vec<PlayerInfo>,
        saved: bool,
        events: Vec<String>,
    },
    /// Investigation result (sent privately to Detective)
    InvestigationResult {
        target_name: String,
        appears_guilty: bool,
    },
    /// Vote update (broadcast)
    VoteUpdate {
        votes: Vec<VoteInfo>,
        timer_remaining: u32,
    },
    /// Vote result
    VoteResult {
        target: Option<PlayerInfo>,
        was_lynched: bool,
    },
    /// Game over
    GameOver {
        winner: String,
        player_roles: Vec<PlayerRoleReveal>,
    },
    /// Player ready-to-vote state changed (broadcast to host)
    ReadyToVoteUpdate {
        player_id: String,
        player_name: String,
        ready: bool,
    },
    /// All alive players ready to vote — auto-transition
    AllReadyToVote,
    /// Error
    Error { message: String },
    /// Player list update
    PlayerList { players: Vec<PlayerInfo> },
    /// Alive players list
    AlivePlayerList { players: Vec<PlayerInfo> },
    /// Reconnect state (sent to reconnecting player)
    ReconnectState {
        player_id: String,
        room_code: String,
        phase: GamePhase,
        round: u32,
        alive_players: Vec<PlayerInfo>,
        role: Option<Role>,
        description_key: Option<String>,
        faction: Option<String>,
        votes: Option<Vec<VoteInfo>>,
    },
    /// Mini-game started (broadcast to all)
    MiniGameStart {
        game_type: MiniGameType,
        config: serde_json::Value,
        participants: Vec<String>,
    },
    /// Mini-game prompt (sent to individual players)
    MiniGamePrompt {
        game_type: MiniGameType,
        prompt: serde_json::Value,
    },
    /// Mini-game result (sent to host for display)
    MiniGameResult {
        game_type: MiniGameType,
        result: serde_json::Value,
    },
    /// Player ready state changed (broadcast to host)
    PlayerReadyUpdate {
        player_id: String,
        player_name: String,
        ready: bool,
    },
    /// All players ready — game auto-starting in N seconds
    AutoStartCountdown { seconds: u32 },
    /// Auto-start cancelled (a player un-readied)
    AutoStartCancelled,
    /// Narration step — sent to host to display text and play audio
    NarrationStep {
        key: String,
        text: String,
        audio_file: String,
        wait_for: WaitFor,
        target_player_id: Option<String>,
    },
    /// Sent to a specific player when their role is woken up
    WakeUp { role: String, instruction: String },
    /// Sent to a player when their night turn is done
    GoToSleep,
    /// Sent to host: show this role being revealed on the TV
    RoleRevealStep {
        role: Role,
        description: String,
        faction: String,
        count: usize,
    },
    /// Sent to ALL players: flip your card
    RoleRevealFlip {
        role: Role,
        role_name: String,
        description: String,
        faction: String,
        is_you: bool,
    },
    /// Sent to host: all roles have been revealed
    RoleRevealComplete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerInfo {
    pub id: String,
    pub name: String,
    pub alive: bool,
    #[serde(default)]
    pub ready: bool,
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
