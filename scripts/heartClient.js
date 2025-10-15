// scripts/heartClient.js
// Lifrea Heart（today.json）を読み、ありさ/こなつが“ときどき自然に”天気へ触れるためのユーティリティ。
// ルール:
// - ありさ: 基本 20% / こなつ: 基本 10%
// - 一度話したらクールダウン（既定60分）
// - 強い天気（雨/雷/雪/嵐）や“天気が変わった直後”“セッション最初”では少しだけ上げる
// - 時間帯に応じた言い回し（夜は「晴れてる」を使わない）
// - 極端な気温のときだけ温度コメントを添える（矛盾排除）

const ENDPOINT = "https://tron-yamamura.github.io/lifrea-heart-engine/today.json"; // 自分のURLに置き換え可

// ==== 小ユーティリティ ====
const LS_LAST_WEATHER = "lifrea:lastWeather";
const LS_LAST_SPEAK_AT = (who) => `lifrea:lastSpeakAt:${who}`;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const nowJst = () => new Date(); // 実用上はローカル時間でOK
const minutesDiff = (a, b) => Math.abs(a.getTime() - b.getTime()) / 60000;
const loadLS = (k, fb=null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function normalizeWeather(w) {
  if (!w) return "";
  return String(w)
    .replace("晴天", "晴れ")
    .replace("厚い雲", "曇り")
    .replace("曇りがち", "曇り")
    .replace("にわか雨", "雨")
    .trim();
}

function categorizeWeather(w) {
  if (!w) return "unknown";
  if (/雷/.test(w)) return "thunder";
  if (/雪/.test(w)) return "snow";
  if (/雨/.test(w)) return "rain";
  if (/霧|もや|靄/.test(w)) return "fog";
  if (/晴/.test(w)) return "clear";
  if (/曇|雲/.test(w)) return "cloudy";
  return "unknown";
}

function timeSegment(h) {
  if (h >= 6 && h < 18) return "day";
  if (h >= 18 && h < 21) return "evening";
  return "night";
}

// 時間帯×天気フレーズ（夜は「晴れ」系ワードを使わない）
function timeWeatherPhrase(who, wCat, seg) {
  const A = who === "arisa";
  if (seg === "day") {
    switch (wCat) {
      case "clear":  return A ? "今日は空が高いね" : "日差し、ちょっと強いかも";
      case "cloudy": return A ? "少し眠たくなる空だね" : "空、重たい感じする";
      case "rain":   return A ? "雨の音、落ち着くね" : "外は濡れてるから気をつけよ";
      case "thunder":return A ? "雷、近いかも…気をつけて" : "空、バリバリ言ってる";
      case "snow":   return A ? "白い景色って静かになるね" : "手袋ほしいやつ";
      case "fog":    return A ? "空気がしっとりしてる" : "視界、短いね";
      default:       return A ? "空気の匂い、少し違う" : "気圧きてるかも";
    }
  }
  if (seg === "evening") {
    switch (wCat) {
      case "clear":  return A ? "夕焼けきれいだね" : "空がオレンジ色だ";
      case "cloudy": return A ? "夕方の雲、低いね" : "風、止んできたかも";
      case "rain":   return A ? "地面から雨の匂いがする" : "音、静かになってきたね";
      case "thunder":return A ? "稲光、少し怖いね" : "音、腹にくるね";
      case "snow":   return A ? "灯りに雪が舞ってる" : "足元、気をつけよ";
      case "fog":    return A ? "街が少しぼやけて見える" : "ライト、にじんで見える";
      default:       return A ? "空の色、ゆっくり変わるね" : "空気、入れ替わってる";
    }
  }
  // night
  switch (wCat) {
    case "clear":  return A ? "星がよく見えるね" : "空、静かだね";
    case "cloudy": return A ? "夜の空、ちょっと重たいね" : "風、止んでる";
    case "rain":   return A ? "雨の音、心拍落ち着く" : "傘の音だけ聞こえる";
    case "thunder":return A ? "夜の雷、胸に響く" : "光ったね…近いかも";
    case "snow":   return A ? "音が吸い込まれてく感じ" : "空気、きゅっとしてる";
    case "fog":    return A ? "夜霧、静かだね" : "歩くと白く混ざる感じ";
    default:       return A ? "今夜は空気がやわらかい" : "空、機嫌いいかも";
  }
}

// 気温フレーズ（極端な時だけ）
function tempPhrase(who, seg, t) {
  if (t == null || !Number.isFinite(t)) return null;
  const A = who === "arisa";
  if (t <= 8)  return A ? "手がかじかむね…" : "寒っ…外出たくない";
  if (t <= 12) return A ? "空気がひんやりして気持ちいい" : "ちょっと冷えるね";
  if (t >= 33) return A ? "暑すぎて溶けそう…" : "アイス食べたい…";
  if (t >= 30) return A ? "少し息苦しい暑さだね" : "日中は無理しないでこ";
  return null;
}

// 互換性チェック（夜に「晴れ」や「日差し」はNG）
function isPhraseIncompatible(phrase, seg, wCat) {
  if (!phrase) return false;
  const p = String(phrase);
  if (seg === "night" && wCat === "clear" && /晴/.test(p)) return true;
  if (seg === "night" && /日差し|日焼け|陽射し/.test(p)) return true;
  return false;
}

// today.json を取る
export async function getHeartContext() {
  const res = await fetch(`${ENDPOINT}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return await res.json();
}

/**
 * 今回の発話で天気の一言を“出すなら返す/出さないなら null”
 * @param {"arisa"|"konatsu"} who
 * @param {object} heart  getHeartContext() の結果
 * @param {object} opts  { minCooldownMinutes=60, baseRate?, daytimeOnly=true, sessionStart=false }
 */
export function maybeWeatherLine(who, heart, opts = {}) {
  if (!heart) return null;

  const now = nowJst();
  const hour = now.getHours();
  const seg = timeSegment(hour);

  // 夜中は無口（06–23 以外は黙る）
  const daytimeOnly = opts.daytimeOnly ?? true;
  if (daytimeOnly && !(hour >= 6 && hour < 23)) return null;

  // クールダウン
  const minCooldown = Math.max(1, opts.minCooldownMinutes ?? 60);
  const lastAtISO = loadLS(LS_LAST_SPEAK_AT(who), null);
  if (lastAtISO) {
    const lastAt = new Date(lastAtISO);
    if (minutesDiff(now, lastAt) < minCooldown) return null;
  }

  // 天気
  const wNorm = normalizeWeather(heart.weather);
  const wCat  = categorizeWeather(wNorm);
  const temp  = typeof heart.temp_c === "number" ? heart.temp_c : null;

  // 既定確率
  let base =
    opts.baseRate ??
    (who === "arisa" ? 0.20 :
     who === "konatsu" ? 0.10 : 0.15);

  // 強い天気で少しブースト
  if (/(rain|thunder|snow)/.test(wCat)) base += 0.08;

  // 天気変化の直後で少しブースト
  const lastWeather = loadLS(LS_LAST_WEATHER, null);
  if (lastWeather && lastWeather !== wNorm) base += 0.07;

  // セッション最初
  if (opts.sessionStart) base += 0.05;

  // 極端な気温の時は、発話自体も少しだけ上げる
  if (temp != null && (temp <= 8 || temp >= 33)) base += 0.05;

  base = clamp01(base);

  // 抽選
  if (Math.random() >= base) {
    saveLS(LS_LAST_WEATHER, wNorm);
    return null;
  }

  // 台詞の決定
  const scripted = who === "arisa" ? heart?.phrase?.arisa : heart?.phrase?.konatsu;
  let line = null;

  // 1) マップ台詞（矛盾しないなら最優先）
  if (scripted && !isPhraseIncompatible(scripted, seg, wCat)) {
    line = scripted;
  }

  // 2) 矛盾/未設定 → 時間帯×天気の安全フレーズ
  if (!line) line = timeWeatherPhrase(who, wCat, seg);

  // 3) 極端な気温なら、夜でも矛盾しない温度フレーズで置換/補完
  const tLine = tempPhrase(who, seg, temp);
  if (tLine) {
    if (wCat === "clear" || wCat === "cloudy" || wCat === "fog" || wCat === "unknown") {
      line = tLine;
    } else {
      if (Math.random() < 0.4) line = tLine;
    }
  }

  // 記録
  saveLS(LS_LAST_WEATHER, wNorm);
  saveLS(LS_LAST_SPEAK_AT(who), now.toISOString());

  return line || null;
}
