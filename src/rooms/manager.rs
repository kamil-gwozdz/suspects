use rand::Rng;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::game::narrator::NarrationStep;
use crate::game::roles::Role;
use crate::game::state::{GamePhase, GameState};
use crate::ws::messages::PlayerInfo;

/// Maximum number of players allowed in a single room.
pub const MAX_PLAYERS: usize = 30;

#[derive(Debug, Clone)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub alive: bool,
    pub ready: bool,
    pub connected: bool,
    pub disconnected_at: Option<Instant>,
    pub tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

impl Player {
    pub fn to_info(&self) -> PlayerInfo {
        PlayerInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            alive: self.alive,
            ready: self.ready,
        }
    }
}

#[derive(Debug)]
pub struct Room {
    pub id: String,
    pub code: String,
    pub language: String,
    pub game_state: GameState,
    pub players: Vec<Player>,
    pub host_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    pub votes: HashMap<String, Option<String>>,
    pub night_actions: Vec<crate::game::phases::NightAction>,
    pub created_at: Instant,
    /// When the host disconnected; `None` if host is connected.
    pub host_disconnected_at: Option<Instant>,
    /// Remaining narration steps to execute.
    pub narration_queue: Vec<NarrationStep>,
    /// The currently active narration step.
    pub narration_current: Option<NarrationStep>,
    /// Player IDs we are waiting for before advancing narration.
    pub narration_ack_pending: HashSet<String>,
    /// Remaining roles to reveal during the RoleReveal phase.
    pub role_reveal_queue: Vec<Role>,
}

impl Room {
    pub fn new(language: String) -> Self {
        let code = generate_room_code();
        Self {
            id: Uuid::new_v4().to_string(),
            code,
            language,
            game_state: GameState::default(),
            players: Vec::new(),
            host_tx: None,
            votes: HashMap::new(),
            night_actions: Vec::new(),
            created_at: Instant::now(),
            host_disconnected_at: None,
            narration_queue: Vec::new(),
            narration_current: None,
            narration_ack_pending: HashSet::new(),
            role_reveal_queue: Vec::new(),
        }
    }

    /// Reconstruct a Room from persisted DB data (server restart recovery).
    pub fn from_loaded(loaded: crate::db::LoadedGame) -> Self {
        let players: Vec<Player> = loaded
            .players
            .into_iter()
            .map(|lp| Player {
                id: lp.id,
                name: lp.name,
                role: lp.role,
                alive: lp.alive,
                ready: false,
                connected: false,
                disconnected_at: Some(Instant::now()),
                tx: None,
            })
            .collect();

        Self {
            id: loaded.id,
            code: loaded.code,
            language: loaded.language,
            game_state: GameState {
                phase: loaded.phase,
                round: loaded.round,
                day_timer_secs: loaded.day_timer_secs,
                night_timer_secs: loaded.night_timer_secs,
                voting_timer_secs: loaded.voting_timer_secs,
            },
            players,
            host_tx: None,
            votes: HashMap::new(),
            night_actions: Vec::new(),
            created_at: Instant::now(),
            host_disconnected_at: Some(Instant::now()),
            narration_queue: Vec::new(),
            narration_current: None,
            narration_ack_pending: HashSet::new(),
            role_reveal_queue: Vec::new(),
        }
    }

    pub fn add_player(&mut self, name: String) -> String {
        let id = Uuid::new_v4().to_string();
        self.players.push(Player {
            id: id.clone(),
            name,
            role: None,
            alive: true,
            ready: false,
            connected: true,
            disconnected_at: None,
            tx: None,
        });
        id
    }

    /// Remove a player by ID. Only allowed during Lobby phase.
    /// Returns the removed player's name if successful.
    pub fn remove_player(&mut self, id: &str) -> Option<String> {
        if self.game_state.phase != GamePhase::Lobby {
            return None;
        }
        if let Some(pos) = self.players.iter().position(|p| p.id == id) {
            let player = self.players.remove(pos);
            Some(player.name)
        } else {
            None
        }
    }

    /// Returns a snapshot of current game state for reconnecting players.
    pub fn get_game_snapshot(&self) -> GameSnapshot {
        GameSnapshot {
            phase: self.game_state.phase,
            round: self.game_state.round,
            alive_players: self.alive_players().iter().map(|p| p.to_info()).collect(),
        }
    }

    pub fn alive_players(&self) -> Vec<&Player> {
        self.players.iter().filter(|p| p.alive).collect()
    }

    /// Returns `true` if the room has reached the maximum player capacity.
    pub fn is_full(&self) -> bool {
        self.players.len() >= MAX_PLAYERS
    }

    /// Returns `true` if there are at least 6 players and all are ready.
    pub fn all_players_ready(&self) -> bool {
        self.players.len() >= 6 && self.players.iter().all(|p| p.ready)
    }

    /// Returns `true` if a player with the given name (case-insensitive) already exists.
    pub fn has_player_named(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.players.iter().any(|p| p.name.to_lowercase() == lower)
    }

    /// Returns `true` if the given action kind is permitted in the current phase.
    /// `action` should be one of: `"join"`, `"night_action"`, `"vote"`, `"start"`.
    pub fn phase_allows_action(&self, action: &str) -> bool {
        match action {
            "join" => self.game_state.phase == GamePhase::Lobby,
            "start" => self.game_state.phase == GamePhase::Lobby,
            "night_action" => self.game_state.phase == GamePhase::Night,
            "vote" => self.game_state.phase == GamePhase::Voting,
            _ => false,
        }
    }

    /// Returns `true` if the room has no connected players and no connected host.
    pub fn is_abandoned(&self) -> bool {
        self.host_tx.is_none() && self.players.iter().all(|p| !p.connected)
    }

    pub fn get_player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }

    pub fn get_player_mut(&mut self, id: &str) -> Option<&mut Player> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    pub fn broadcast_to_players(&self, msg: &str) {
        for player in &self.players {
            if let Some(ref tx) = player.tx {
                let _ = tx.send(msg.to_string());
            }
        }
    }

    pub fn send_to_host(&self, msg: &str) {
        if let Some(ref tx) = self.host_tx {
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn send_to_player(&self, player_id: &str, msg: &str) {
        if let Some(player) = self.get_player(player_id) {
            if let Some(ref tx) = player.tx {
                let _ = tx.send(msg.to_string());
            }
        }
    }

    /// Load a new narration script into the queue.
    pub fn set_narration_queue(&mut self, steps: Vec<NarrationStep>) {
        self.narration_queue = steps;
        self.narration_current = None;
        self.narration_ack_pending.clear();
    }

    /// Pop the next step from the narration queue.
    /// Returns `None` when the script is finished.
    pub fn advance_narration(&mut self) -> Option<NarrationStep> {
        if self.narration_queue.is_empty() {
            self.narration_current = None;
            return None;
        }
        let step = self.narration_queue.remove(0);
        self.narration_current = Some(step.clone());
        Some(step)
    }

    /// Returns `true` if a narration script is currently executing.
    pub fn narration_active(&self) -> bool {
        self.narration_current.is_some() || !self.narration_queue.is_empty()
    }

    /// Clear all narration state.
    pub fn clear_narration(&mut self) {
        self.narration_queue.clear();
        self.narration_current = None;
        self.narration_ack_pending.clear();
    }
}

#[derive(Debug, Clone)]
pub struct GameSnapshot {
    pub phase: GamePhase,
    pub round: u32,
    pub alive_players: Vec<PlayerInfo>,
}

fn generate_room_code() -> String {
    let mut rng = rand::rng();
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    (0..4)
        .map(|_| chars[rng.random_range(0..chars.len())])
        .collect()
}

#[derive(Clone)]
pub struct AppState {
    pub rooms: Arc<RwLock<HashMap<String, Arc<Mutex<Room>>>>>,
    pub pool: SqlitePool,
}

impl AppState {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            pool,
        }
    }

    pub async fn create_room(&self, language: String) -> String {
        let room = Room::new(language);
        let code = room.code.clone();
        let mut rooms = self.rooms.write().await;
        rooms.insert(code.clone(), Arc::new(Mutex::new(room)));
        code
    }

    /// Restore a room from persisted DB state (used during server startup).
    pub async fn restore_room(&self, room: Room) -> String {
        let code = room.code.clone();
        let mut rooms = self.rooms.write().await;
        rooms.insert(code.clone(), Arc::new(Mutex::new(room)));
        code
    }

    pub async fn get_room(&self, code: &str) -> Option<Arc<Mutex<Room>>> {
        let rooms = self.rooms.read().await;
        rooms.get(code).cloned()
    }

    /// Remove rooms that have been fully abandoned (no host, no connected players)
    /// for at least `min_age` duration.
    pub async fn remove_abandoned_rooms(&self, min_age: std::time::Duration) -> Vec<String> {
        let rooms = self.rooms.read().await;
        let mut to_remove = Vec::new();

        for (code, room_arc) in rooms.iter() {
            let room = room_arc.lock().await;
            if room.is_abandoned() {
                // Check if the room has been around long enough and host has been gone
                let host_gone_long_enough = room
                    .host_disconnected_at
                    .map_or(false, |t| t.elapsed() >= min_age);
                let all_players_gone_long_enough = room
                    .players
                    .iter()
                    .all(|p| p.disconnected_at.map_or(true, |t| t.elapsed() >= min_age));
                if host_gone_long_enough && all_players_gone_long_enough {
                    to_remove.push(code.clone());
                }
            }
        }
        drop(rooms);

        if !to_remove.is_empty() {
            let mut rooms = self.rooms.write().await;
            for code in &to_remove {
                rooms.remove(code);
            }
        }

        to_remove
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_code_format() {
        let code = generate_room_code();
        assert_eq!(code.len(), 4);
        assert!(code.chars().all(|c| c.is_ascii_alphanumeric()));
        // Should not contain easily confused characters
        assert!(!code.contains('O'));
        assert!(!code.contains('I'));
        assert!(!code.contains('0'));
        assert!(!code.contains('1'));
    }

    #[test]
    fn test_add_player() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        assert!(!id.is_empty());
        assert_eq!(room.players.len(), 1);
        assert_eq!(room.players[0].name, "Alice");
    }

    #[test]
    fn test_alive_players() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        room.players[0].alive = false;
        assert_eq!(room.alive_players().len(), 1);
    }

    #[test]
    fn test_remove_player_in_lobby() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        assert_eq!(room.players.len(), 2);

        let name = room.remove_player(&id);
        assert_eq!(name, Some("Alice".to_string()));
        assert_eq!(room.players.len(), 1);
        assert_eq!(room.players[0].name, "Bob");
    }

    #[test]
    fn test_remove_player_not_in_lobby() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        room.game_state.next_phase(); // RoleReveal
        let name = room.remove_player(&id);
        assert_eq!(name, None);
        assert_eq!(room.players.len(), 1);
    }

    #[test]
    fn test_remove_nonexistent_player() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        let name = room.remove_player("nonexistent");
        assert_eq!(name, None);
        assert_eq!(room.players.len(), 1);
    }

    #[test]
    fn test_get_game_snapshot() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        room.players[0].alive = false;

        let snapshot = room.get_game_snapshot();
        assert_eq!(snapshot.phase, crate::game::state::GamePhase::Lobby);
        assert_eq!(snapshot.round, 0);
        assert_eq!(snapshot.alive_players.len(), 1);
        assert_eq!(snapshot.alive_players[0].name, "Bob");
    }

    #[test]
    fn test_disconnection_timestamp() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        let player = room.get_player_mut(&id).unwrap();
        assert!(player.disconnected_at.is_none());

        let now = std::time::Instant::now();
        player.connected = false;
        player.disconnected_at = Some(now);
        assert!(player.disconnected_at.is_some());

        // Simulate reconnect
        player.connected = true;
        player.disconnected_at = None;
        assert!(player.disconnected_at.is_none());
    }

    #[test]
    fn test_is_full() {
        let mut room = Room::new("en".to_string());
        assert!(!room.is_full());
        for i in 0..MAX_PLAYERS {
            room.add_player(format!("Player{}", i));
        }
        assert!(room.is_full());
    }

    #[test]
    fn test_has_player_named() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        assert!(room.has_player_named("Alice"));
        assert!(room.has_player_named("alice"));
        assert!(room.has_player_named("ALICE"));
        assert!(!room.has_player_named("Bob"));
    }

    #[test]
    fn test_phase_allows_action() {
        let mut room = Room::new("en".to_string());
        // Lobby phase
        assert!(room.phase_allows_action("join"));
        assert!(room.phase_allows_action("start"));
        assert!(!room.phase_allows_action("night_action"));
        assert!(!room.phase_allows_action("vote"));

        room.game_state.next_phase(); // RoleReveal
        room.game_state.next_phase(); // Night
        assert!(!room.phase_allows_action("join"));
        assert!(room.phase_allows_action("night_action"));
        assert!(!room.phase_allows_action("vote"));

        room.game_state.next_phase(); // Dawn
        room.game_state.next_phase(); // Day
        room.game_state.next_phase(); // Voting
        assert!(room.phase_allows_action("vote"));
        assert!(!room.phase_allows_action("night_action"));
    }

    #[test]
    fn test_is_abandoned() {
        let mut room = Room::new("en".to_string());
        // No host, no players — abandoned
        assert!(room.is_abandoned());

        // Add a connected player — not abandoned
        room.add_player("Alice".to_string());
        assert!(!room.is_abandoned());

        // Disconnect the player — abandoned (no host either)
        room.players[0].connected = false;
        assert!(room.is_abandoned());
    }
}
