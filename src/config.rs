use std::env;

pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    #[allow(dead_code)]
    pub base_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            host: env::var("SUSPECTS_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: env::var("SUSPECTS_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8080),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:suspects.db?mode=rwc".to_string()),
            base_url: env::var("SUSPECTS_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:8080".to_string()),
        }
    }
}
