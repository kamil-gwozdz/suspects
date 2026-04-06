use axum::{
    Router,
    routing::get,
};
use sqlx::sqlite::SqlitePoolOptions;
#[cfg(debug_assertions)]
use tower_http::services::ServeDir;

mod config;
mod db;
mod game;
mod rooms;
mod ws;

// In release mode, embed the entire static/ directory into the binary.
#[cfg(not(debug_assertions))]
#[derive(rust_embed::Embed)]
#[folder = "static/"]
struct StaticAssets;

#[cfg(not(debug_assertions))]
async fn serve_embedded(uri: axum::http::Uri) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};

    let path = uri.path().trim_start_matches('/');

    // Try exact path, then with index.html for directory-style requests
    let candidates = if path.is_empty() || path.ends_with('/') {
        vec![format!("{}index.html", path)]
    } else {
        vec![path.to_string(), format!("{}/index.html", path)]
    };

    for candidate in &candidates {
        if let Some(content) = StaticAssets::get(candidate) {
            let mime = mime_from_path(candidate);
            return axum::response::Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(content.data.into_owned()))
                .unwrap();
        }
    }

    axum::response::Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

#[cfg(not(debug_assertions))]
fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = config::Config::from_env();
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");

    db::run_migrations(&pool).await;

    let app_state = rooms::manager::AppState::new(pool);

    let app = Router::new()
        .route("/ws/host", get(ws::handler::host_ws_handler))
        .route("/ws/player", get(ws::handler::player_ws_handler))
        .route("/", get(|| async { axum::response::Redirect::permanent("/host/") }));

    // Debug: serve static files from disk (supports hot reload).
    // Release: serve embedded static files from the binary.
    #[cfg(debug_assertions)]
    let app = app
        .nest_service("/host", ServeDir::new("static/host"))
        .nest_service("/player", ServeDir::new("static/player"))
        .nest_service("/shared", ServeDir::new("static/shared"))
        .nest_service("/i18n", ServeDir::new("static/i18n"));

    #[cfg(not(debug_assertions))]
    let app = app.fallback(serve_embedded);

    let app = app.with_state(app_state);

    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("Suspects server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

