use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GamePhase {
    Lobby,
    RoleReveal,
    Night,
    Dawn,
    Day,
    Voting,
    Execution,
    GameOver,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameState {
    pub phase: GamePhase,
    pub round: u32,
    pub day_timer_secs: u32,
    pub night_timer_secs: u32,
    pub voting_timer_secs: u32,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            phase: GamePhase::Lobby,
            round: 0,
            day_timer_secs: std::env::var("SUSPECTS_DAY_TIMER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
            night_timer_secs: std::env::var("SUSPECTS_NIGHT_TIMER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
            voting_timer_secs: std::env::var("SUSPECTS_VOTING_TIMER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
        }
    }
}

impl GameState {
    pub fn next_phase(&mut self) -> GamePhase {
        self.phase = match self.phase {
            GamePhase::Lobby => GamePhase::RoleReveal,
            GamePhase::RoleReveal => {
                self.round = 1;
                GamePhase::Night
            }
            GamePhase::Night => GamePhase::Dawn,
            GamePhase::Dawn => GamePhase::Day,
            GamePhase::Day => GamePhase::Voting,
            GamePhase::Voting => GamePhase::Execution,
            GamePhase::Execution => {
                self.round += 1;
                GamePhase::Night
            }
            GamePhase::GameOver => GamePhase::GameOver,
        };
        self.phase
    }

    pub fn end_game(&mut self) {
        self.phase = GamePhase::GameOver;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_state_is_lobby() {
        let state = GameState::default();
        assert_eq!(state.phase, GamePhase::Lobby);
        assert_eq!(state.round, 0);
    }

    #[test]
    fn test_phase_progression() {
        let mut state = GameState::default();
        assert_eq!(state.next_phase(), GamePhase::RoleReveal);
        assert_eq!(state.next_phase(), GamePhase::Night);
        assert_eq!(state.round, 1);
        assert_eq!(state.next_phase(), GamePhase::Dawn);
        assert_eq!(state.next_phase(), GamePhase::Day);
        assert_eq!(state.next_phase(), GamePhase::Voting);
        assert_eq!(state.next_phase(), GamePhase::Execution);
        assert_eq!(state.next_phase(), GamePhase::Night);
        assert_eq!(state.round, 2);
    }

    #[test]
    fn test_game_over_stays() {
        let mut state = GameState::default();
        state.end_game();
        assert_eq!(state.phase, GamePhase::GameOver);
        assert_eq!(state.next_phase(), GamePhase::GameOver);
    }
}
