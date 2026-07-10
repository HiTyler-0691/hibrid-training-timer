// Spotify Authorization Code with PKCE flow + a thin Web API wrapper.
// No client secret needed — everything here is safe to run in the browser.

const CLIENT_ID = "2700944823724441b30a58b179bcb27c";
const REDIRECT_URI = window.location.origin + "/";
const SCOPES = [
  "streaming",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
].join(" ");

const LS_VERIFIER = "spotify_code_verifier";
const LS_ACCESS = "spotify_access_token";
const LS_REFRESH = "spotify_refresh_token";
const LS_EXPIRES = "spotify_expires_at";

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function codeChallengeFor(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(digest);
}

export async function redirectToSpotifyLogin() {
  const verifier = randomString(64);
  localStorage.setItem(LS_VERIFIER, verifier);
  const challenge = await codeChallengeFor(verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function storeToken(data) {
  localStorage.setItem(LS_ACCESS, data.access_token);
  localStorage.setItem(LS_EXPIRES, String(Date.now() + data.expires_in * 1000));
  if (data.refresh_token) localStorage.setItem(LS_REFRESH, data.refresh_token);
}

// Call this once on app load. Returns true if a Spotify login redirect was
// just handled (so the caller can update its "connected" state).
export async function handleSpotifyRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return false;

  const verifier = localStorage.getItem(LS_VERIFIER);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier || "",
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();

  // Clean the ?code=... out of the URL either way so a refresh doesn't re-run this.
  window.history.replaceState({}, document.title, window.location.pathname);

  if (data.access_token) {
    storeToken(data);
    return true;
  }
  return false;
}

async function refreshAccessToken() {
  const refresh_token = localStorage.getItem(LS_REFRESH);
  if (!refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: CLIENT_ID,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (data.access_token) {
    storeToken(data);
    return data.access_token;
  }
  return null;
}

function getFreshAccessToken() {
  const token = localStorage.getItem(LS_ACCESS);
  const expiresAt = Number(localStorage.getItem(LS_EXPIRES) || 0);
  if (token && Date.now() < expiresAt - 5000) return token;
  return null;
}

export function isSpotifyConnected() {
  return !!localStorage.getItem(LS_REFRESH);
}

export function spotifyLogout() {
  [LS_VERIFIER, LS_ACCESS, LS_REFRESH, LS_EXPIRES].forEach((k) => localStorage.removeItem(k));
}

// Thin wrapper around the Web API that refreshes the token once and retries on 401.
export async function spotifyFetch(path, options = {}, _retried = false) {
  let token = getFreshAccessToken();
  if (!token) token = await refreshAccessToken();
  if (!token) throw new Error("스포티파이 로그인이 필요해요.");

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401 && !_retried) {
    await refreshAccessToken();
    return spotifyFetch(path, options, true);
  }
  return res;
}
