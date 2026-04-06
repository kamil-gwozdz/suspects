use super::roles::Role;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightAction {
    pub actor_id: String,
    pub role: Role,
    pub target_id: Option<String>,
    /// For Witch: secondary target for redirection
    pub secondary_target_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightResult {
    pub killed: Vec<String>,
    pub healed: Vec<String>,
    pub investigated: Vec<(String, bool)>, // (target_id, appears_guilty)
    pub blocked: Vec<String>,
    pub cleaned: Vec<String>, // Janitor-cleaned deaths (role hidden)
}

/// Resolves all night actions and returns the results.
pub fn resolve_night(
    actions: &[NightAction],
    alive_players: &HashMap<String, Role>,
) -> NightResult {
    let mut result = NightResult {
        killed: Vec::new(),
        healed: Vec::new(),
        investigated: Vec::new(),
        blocked: Vec::new(),
        cleaned: Vec::new(),
    };

    // 1. Collect blocked players (Escort/Consort)
    let blocked: Vec<String> = actions
        .iter()
        .filter(|a| matches!(a.role, Role::Escort | Role::Consort))
        .filter_map(|a| a.target_id.clone())
        .collect();
    result.blocked = blocked.clone();

    let is_blocked = |id: &str| blocked.contains(&id.to_string());

    // 2. Collect mafia kill target (majority vote among unblocked mafia)
    let mafia_targets: Vec<&str> = actions
        .iter()
        .filter(|a| matches!(a.role, Role::Mafioso | Role::Godfather))
        .filter(|a| !is_blocked(&a.actor_id))
        .filter_map(|a| a.target_id.as_deref())
        .collect();

    let mafia_target = majority_vote(&mafia_targets);

    // 3. Doctor heal target
    let heal_target: Option<String> = actions
        .iter()
        .find(|a| a.role == Role::Doctor && !is_blocked(&a.actor_id))
        .and_then(|a| a.target_id.clone());
    if let Some(ref target) = heal_target {
        result.healed.push(target.clone());
    }

    // 4. Apply mafia kill
    if let Some(target) = mafia_target {
        let target_role = alive_players.get(target);
        let is_immune = target_role.map_or(false, |r| r.is_immune_to_mafia());
        let is_healed = heal_target.as_deref() == Some(target);

        if !is_immune && !is_healed {
            result.killed.push(target.to_string());

            // Check if Janitor cleaned
            let janitor_cleaned = actions.iter().any(|a| {
                a.role == Role::Janitor
                    && !is_blocked(&a.actor_id)
                    && a.target_id.as_deref() == Some(target)
            });
            if janitor_cleaned {
                result.cleaned.push(target.to_string());
            }
        }
    }

    // 5. Serial Killer kill
    for action in actions
        .iter()
        .filter(|a| a.role == Role::SerialKiller && !is_blocked(&a.actor_id))
    {
        if let Some(ref target) = action.target_id {
            let is_healed = heal_target.as_deref() == Some(target.as_str());
            if !is_healed && !result.killed.contains(target) {
                result.killed.push(target.clone());
            }
        }
    }

    // 6. Vigilante kill
    for action in actions
        .iter()
        .filter(|a| a.role == Role::Vigilante && !is_blocked(&a.actor_id))
    {
        if let Some(ref target) = action.target_id {
            let is_healed = heal_target.as_deref() == Some(target.as_str());
            if !is_healed && !result.killed.contains(target) {
                result.killed.push(target.clone());
            }
        }
    }

    // 7. Detective investigation
    for action in actions
        .iter()
        .filter(|a| a.role == Role::Detective && !is_blocked(&a.actor_id))
    {
        if let Some(ref target) = action.target_id {
            let target_role = alive_players.get(target.as_str());
            // Godfather appears innocent
            let appears_guilty = target_role.map_or(false, |r| {
                r.faction() == super::roles::Faction::Mafia && *r != Role::Godfather
            });
            result.investigated.push((target.clone(), appears_guilty));
        }
    }

    result
}

fn majority_vote<'a>(votes: &[&'a str]) -> Option<&'a str> {
    if votes.is_empty() {
        return None;
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for vote in votes {
        *counts.entry(vote).or_insert(0) += 1;
    }
    counts.into_iter().max_by_key(|(_, c)| *c).map(|(t, _)| t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_players() -> HashMap<String, Role> {
        let mut players = HashMap::new();
        players.insert("p1".to_string(), Role::Civilian);
        players.insert("p2".to_string(), Role::Civilian);
        players.insert("p3".to_string(), Role::Doctor);
        players.insert("p4".to_string(), Role::Detective);
        players.insert("m1".to_string(), Role::Mafioso);
        players.insert("m2".to_string(), Role::Mafioso);
        players
    }

    #[test]
    fn test_mafia_kills_civilian() {
        let players = make_players();
        let actions = vec![
            NightAction {
                actor_id: "m1".into(),
                role: Role::Mafioso,
                target_id: Some("p1".into()),
                secondary_target_id: None,
            },
            NightAction {
                actor_id: "m2".into(),
                role: Role::Mafioso,
                target_id: Some("p1".into()),
                secondary_target_id: None,
            },
        ];
        let result = resolve_night(&actions, &players);
        assert!(result.killed.contains(&"p1".to_string()));
    }

    #[test]
    fn test_doctor_saves() {
        let players = make_players();
        let actions = vec![
            NightAction {
                actor_id: "m1".into(),
                role: Role::Mafioso,
                target_id: Some("p1".into()),
                secondary_target_id: None,
            },
            NightAction {
                actor_id: "p3".into(),
                role: Role::Doctor,
                target_id: Some("p1".into()),
                secondary_target_id: None,
            },
        ];
        let result = resolve_night(&actions, &players);
        assert!(!result.killed.contains(&"p1".to_string()));
        assert!(result.healed.contains(&"p1".to_string()));
    }

    #[test]
    fn test_detective_finds_mafia() {
        let players = make_players();
        let actions = vec![NightAction {
            actor_id: "p4".into(),
            role: Role::Detective,
            target_id: Some("m1".into()),
            secondary_target_id: None,
        }];
        let result = resolve_night(&actions, &players);
        assert_eq!(result.investigated, vec![("m1".to_string(), true)]);
    }

    #[test]
    fn test_godfather_appears_innocent() {
        let mut players = make_players();
        players.insert("gf".to_string(), Role::Godfather);
        let actions = vec![NightAction {
            actor_id: "p4".into(),
            role: Role::Detective,
            target_id: Some("gf".into()),
            secondary_target_id: None,
        }];
        let result = resolve_night(&actions, &players);
        assert_eq!(result.investigated, vec![("gf".to_string(), false)]);
    }

    #[test]
    fn test_escort_blocks_mafia() {
        let players = make_players();
        let actions = vec![
            NightAction {
                actor_id: "m1".into(),
                role: Role::Mafioso,
                target_id: Some("p1".into()),
                secondary_target_id: None,
            },
            NightAction {
                actor_id: "p1".into(),
                role: Role::Escort,
                target_id: Some("m1".into()),
                secondary_target_id: None,
            },
        ];
        // m1 blocked, only m1 voted so no kill
        let result = resolve_night(&actions, &players);
        assert!(!result.killed.contains(&"p1".to_string()));
    }

    #[test]
    fn test_serial_killer_immune_to_mafia() {
        let mut players = make_players();
        players.insert("sk".to_string(), Role::SerialKiller);
        let actions = vec![NightAction {
            actor_id: "m1".into(),
            role: Role::Mafioso,
            target_id: Some("sk".into()),
            secondary_target_id: None,
        }];
        let result = resolve_night(&actions, &players);
        assert!(!result.killed.contains(&"sk".to_string()));
    }
}
