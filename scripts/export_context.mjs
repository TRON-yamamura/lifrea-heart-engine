import { Client } from "@notionhq/client";
import fs from "fs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
dayjs.extend(utc); dayjs.extend(tz);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const HEART_DB_ID = process.env.HEART_DB_ID;

// Notion プロパティ名はあなたの DB に合わせて（ここは今の構成そのまま）
const PROPS = {
  time: "time_iso",
  weather: "weather",
  temp_c: "temp_c",
  phrase_arisa: "phrase_arisa_rollup",
  phrase_konatsu: "phrase_konatsu_rollup",
  weather_link: "weather_link",
};

function pickSelect(prop) {
  return prop?.select?.name ?? null;
}
function pickNumber(prop) {
  return typeof prop?.number === "number" ? prop.number : null;
}
function pickRollupText(prop) {
  // rollup が「rich_text のリスト」を返している前提
  const arr = prop?.rollup?.array || [];
  const texts = [];
  for (const v of arr) {
    const t = v?.rich_text?.[0]?.plain_text ?? v?.title?.[0]?.plain_text ?? null;
    if (t) texts.push(t);
  }
  return texts[0] ?? null;
}

(async () => {
  // 最新1件（weather_link が埋まっているものを優先）
  const q = await notion.databases.query({
    database_id: HEART_DB_ID,
    sorts: [{ property: PROPS.time, direction: "descending" }],
    page_size: 5,
  });

  const row = q.results.find(r => r.properties?.[PROPS.weather_link]) || q.results[0];
  if (!row) throw new Error("No rows found in Heart DB");

  const p = row.properties;
  const timeISO = p[PROPS.time]?.date?.start ?? null;

  const payload = {
    updated_at: dayjs().tz("Asia/Tokyo").format(),   // 生成時刻
    time_iso: timeISO,
    time_local: timeISO ? dayjs(timeISO).tz("Asia/Tokyo").format("YYYY-MM-DD HH:mm") : null,
    weather: pickSelect(p[PROPS.weather]),
    temp_c: pickNumber(p[PROPS.temp_c]),
    phrase: {
      arisa: pickRollupText(p[PROPS.phrase_arisa]),
      konatsu: pickRollupText(p[PROPS.phrase_konatsu]),
    },
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/today.json", JSON.stringify(payload, null, 2));
  console.log("Exported public/today.json →", payload);
})();
