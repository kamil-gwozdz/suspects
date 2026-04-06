use super::roles::Role;
use rand::seq::SliceRandom;

/// Generates a role list appropriate for the given player count (6-30).
pub fn assign_roles(player_count: usize) -> Vec<Role> {
    let mut roles = build_role_pool(player_count);

    let mut rng = rand::rng();
    roles.shuffle(&mut rng);
    roles.truncate(player_count);
    roles
}

fn build_role_pool(count: usize) -> Vec<Role> {
    let mut roles = Vec::with_capacity(count);

    // Mafia scaling per classic Mafia rules:
    // 6-7: 2, 8-10: 3, 11-13: 4, 14-16: 5, 17-20: 6, 21-25: 7, 26-30: 8
    let mafia_count = match count {
        6..=7 => 2,
        8..=10 => 3,
        11..=13 => 4,
        14..=16 => 5,
        17..=20 => 6,
        21..=25 => 7,
        _ => 8, // 26-30
    };

    // Always at least basic mafia
    for _ in 0..mafia_count.min(count) {
        roles.push(Role::Mafioso);
    }

    // Upgrade first mafioso to Godfather at 12+ players
    if count >= 12 {
        roles[0] = Role::Godfather;
    }
    // Add Consort at 20+ players (replace a mafioso)
    if count >= 20 && roles.len() >= 2 {
        roles[1] = Role::Consort;
    }
    // Add Janitor at 25+ players (replace a mafioso)
    if count >= 25 && roles.len() >= 3 {
        roles[2] = Role::Janitor;
    }

    // Town specials
    roles.push(Role::Doctor);
    roles.push(Role::Detective);

    if count >= 10 {
        roles.push(Role::Escort);
    }
    if count >= 15 {
        roles.push(Role::Vigilante);
    }
    if count >= 20 {
        roles.push(Role::Mayor);
    }
    if count >= 25 {
        roles.push(Role::Spy);
    }

    // Neutrals
    if count >= 12 {
        roles.push(Role::Jester);
    }
    if count >= 15 {
        roles.push(Role::Survivor);
    }
    if count >= 20 {
        roles.push(Role::SerialKiller);
    }
    if count >= 25 {
        roles.push(Role::Executioner);
    }
    if count >= 28 {
        roles.push(Role::Witch);
    }

    // Fill remaining slots with Civilians
    while roles.len() < count {
        roles.push(Role::Civilian);
    }

    roles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roles::Faction;

    #[test]
    fn test_correct_count() {
        for count in 6..=30 {
            let roles = assign_roles(count);
            assert_eq!(roles.len(), count, "Wrong role count for {} players", count);
        }
    }

    #[test]
    fn test_mafia_scaling() {
        let roles_6 = assign_roles(6);
        let mafia_6 = roles_6
            .iter()
            .filter(|r| r.faction() == Faction::Mafia)
            .count();
        assert_eq!(mafia_6, 2);

        let roles_8 = assign_roles(8);
        let mafia_8 = roles_8
            .iter()
            .filter(|r| r.faction() == Faction::Mafia)
            .count();
        assert_eq!(mafia_8, 3);

        let roles_12 = assign_roles(12);
        let mafia_12 = roles_12
            .iter()
            .filter(|r| r.faction() == Faction::Mafia)
            .count();
        assert_eq!(mafia_12, 4);

        let roles_15 = assign_roles(15);
        let mafia_15 = roles_15
            .iter()
            .filter(|r| r.faction() == Faction::Mafia)
            .count();
        assert_eq!(mafia_15, 5);

        let roles_20 = assign_roles(20);
        let mafia_20 = roles_20
            .iter()
            .filter(|r| r.faction() == Faction::Mafia)
            .count();
        assert_eq!(mafia_20, 6);
    }

    #[test]
    fn test_always_has_doctor_and_detective() {
        for count in 6..=30 {
            let roles = assign_roles(count);
            assert!(
                roles.contains(&Role::Doctor),
                "No Doctor for {} players",
                count
            );
            assert!(
                roles.contains(&Role::Detective),
                "No Detective for {} players",
                count
            );
        }
    }

    #[test]
    fn test_godfather_at_12_plus() {
        let roles_11 = assign_roles(11);
        assert!(!roles_11.contains(&Role::Godfather));

        let roles_12 = assign_roles(12);
        assert!(roles_12.contains(&Role::Godfather));
    }

    #[test]
    fn test_roles_shuffled() {
        let r1 = assign_roles(10);
        let r2 = assign_roles(10);
        // Very unlikely to be identical (would need exact same shuffle)
        // Just verify they contain the same roles
        let mut s1 = r1.clone();
        let mut s2 = r2.clone();
        s1.sort_by_key(|r| format!("{:?}", r));
        s2.sort_by_key(|r| format!("{:?}", r));
        assert_eq!(s1, s2);
    }
}
