use super::roles::{Faction, Role};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Winner {
    Town,
    Mafia,
    SerialKiller,
    Jester(String),      // player_id of Jester
    Executioner(String), // player_id of Executioner
    Draw,
}

pub struct PlayerState {
    #[allow(dead_code)]
    pub id: String,
    pub role: Role,
    pub alive: bool,
}

/// Check win conditions. Returns Some(Winner) if the game is over.
pub fn check_win(players: &[PlayerState]) -> Option<Winner> {
    let alive: Vec<&PlayerState> = players.iter().filter(|p| p.alive).collect();

    // If no players are alive at all, it's a draw
    if alive.is_empty() {
        return Some(Winner::Draw);
    }

    let town_alive = alive
        .iter()
        .filter(|p| p.role.faction() == Faction::Town)
        .count();
    let mafia_alive = alive
        .iter()
        .filter(|p| p.role.faction() == Faction::Mafia)
        .count();
    let sk_alive = alive.iter().any(|p| p.role == Role::SerialKiller);

    // Serial Killer wins if they're the last one standing
    if sk_alive && alive.len() <= 2 && mafia_alive == 0 && town_alive <= 1 {
        return Some(Winner::SerialKiller);
    }

    // Mafia wins if they equal or outnumber town (and no SK)
    if mafia_alive > 0 && mafia_alive >= town_alive && !sk_alive {
        return Some(Winner::Mafia);
    }

    // Town wins if all mafia and neutral killers are dead
    if mafia_alive == 0 && !sk_alive {
        return Some(Winner::Town);
    }

    None
}

/// Check if Jester was lynched (called after a lynch vote).
pub fn check_jester_win(lynched_player: &PlayerState) -> Option<Winner> {
    if lynched_player.role == Role::Jester {
        Some(Winner::Jester(lynched_player.id.clone()))
    } else {
        None
    }
}

/// Check if Executioner's target was lynched.
pub fn check_executioner_win(
    _lynched_player: &PlayerState,
    players: &[PlayerState],
) -> Option<Winner> {
    for p in players {
        if p.role == Role::Executioner && p.alive {
            // Executioner's target would be tracked in game state
            // Target tracking will be added when Executioner target assignment is implemented
            let _ = p;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, role: Role, alive: bool) -> PlayerState {
        PlayerState {
            id: id.to_string(),
            role,
            alive,
        }
    }

    #[test]
    fn test_town_wins() {
        let players = vec![
            p("1", Role::Civilian, true),
            p("2", Role::Doctor, true),
            p("3", Role::Mafioso, false),
            p("4", Role::Mafioso, false),
        ];
        assert_eq!(check_win(&players), Some(Winner::Town));
    }

    #[test]
    fn test_mafia_wins() {
        let players = vec![
            p("1", Role::Civilian, true),
            p("2", Role::Mafioso, true),
            p("3", Role::Doctor, false),
        ];
        assert_eq!(check_win(&players), Some(Winner::Mafia));
    }

    #[test]
    fn test_game_continues() {
        let players = vec![
            p("1", Role::Civilian, true),
            p("2", Role::Civilian, true),
            p("3", Role::Doctor, true),
            p("4", Role::Mafioso, true),
        ];
        assert_eq!(check_win(&players), None);
    }

    #[test]
    fn test_jester_wins_on_lynch() {
        let jester = p("5", Role::Jester, true);
        assert_eq!(
            check_jester_win(&jester),
            Some(Winner::Jester("5".to_string()))
        );
    }

    #[test]
    fn test_sk_wins_last_standing() {
        let players = vec![
            p("1", Role::SerialKiller, true),
            p("2", Role::Civilian, true),
            p("3", Role::Mafioso, false),
        ];
        assert_eq!(check_win(&players), Some(Winner::SerialKiller));
    }

    #[test]
    fn test_draw_when_all_dead() {
        let players = vec![
            p("1", Role::Civilian, false),
            p("2", Role::Mafioso, false),
            p("3", Role::Doctor, false),
        ];
        assert_eq!(check_win(&players), Some(Winner::Draw));
    }

    #[test]
    fn test_draw_empty_board() {
        let players: Vec<PlayerState> = vec![];
        assert_eq!(check_win(&players), Some(Winner::Draw));
    }
}
