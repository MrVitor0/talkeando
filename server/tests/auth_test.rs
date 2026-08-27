mod common;

use common::TestApp;

#[tokio::test]
async fn register_requires_a_valid_invite_code() {
    let app = TestApp::spawn().await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/auth/register", app.http_url))
        .json(&serde_json::json!({
            "invite_code": "does-not-exist",
            "username": "newuser",
            "password": "password123",
            "display_name": "New User",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 400, "AUTH-FR-001: an unknown invite code must be rejected");
    app.teardown().await;
}

#[tokio::test]
async fn register_with_a_valid_invite_creates_a_member_and_logs_them_in() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let (token, user_id) = app.register_member(bootstrap.community_id, "newmember").await;
    assert!(!token.is_empty());

    let client = reqwest::Client::new();
    let me = client
        .get(format!("{}/me", app.http_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
    let body: serde_json::Value = me.json().await.unwrap();
    assert_eq!(body["user"]["id"].as_str().unwrap(), user_id.to_string());
    assert_eq!(
        body["communities"][0].as_str().unwrap(),
        bootstrap.community_id.to_string(),
        "CHAN-FR: a freshly registered member must already belong to the invite's community"
    );

    app.teardown().await;
}

#[tokio::test]
async fn login_with_wrong_password_is_rejected_generically() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let _ = bootstrap;

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth/login", app.http_url))
        .json(&serde_json::json!({ "username": "owner", "password": "totally-wrong" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
    app.teardown().await;
}

#[tokio::test]
async fn login_with_unknown_username_gets_the_same_generic_error_as_wrong_password() {
    // AUTH-NFR-002: the error must not reveal whether the username exists.
    let app = TestApp::spawn().await;

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth/login", app.http_url))
        .json(&serde_json::json!({ "username": "nobody-registered", "password": "whatever123" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
    app.teardown().await;
}

#[tokio::test]
async fn a_request_without_a_bearer_token_is_unauthorized() {
    let app = TestApp::spawn().await;

    let client = reqwest::Client::new();
    let response = client.get(format!("{}/me", app.http_url)).send().await.unwrap();

    assert_eq!(response.status(), 401);
    app.teardown().await;
}

#[tokio::test]
async fn a_revoked_session_can_no_longer_authenticate() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let client = reqwest::Client::new();
    let logout = client
        .post(format!("{}/auth/logout", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 204);

    let me_after_logout = client
        .get(format!("{}/me", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        me_after_logout.status(),
        401,
        "AUTH-FR: a revoked session must be rejected immediately, not just expire eventually"
    );

    app.teardown().await;
}
