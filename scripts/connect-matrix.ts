// Прогон всех веток одношагового подключения против локальной заглушки кабинета.
//
//   python3 scripts/connect-stub.py &
//   SLAVANET_CABINET_BASE=http://127.0.0.1:8899 npx tsx scripts/connect-matrix.ts
//
// Запускается вне Electron: shell там не определён, и это как раз ветка
// «Telegram не открылся», которую флоу обязан пережить.
// Лежит в scripts/ намеренно — эта папка исключена из упаковки приложения.

import { runSubscriptionConnect } from "../src/main/resolve/connect"

const BASE = "http://127.0.0.1:8899"

const SCENARIOS: [string, string][] = [
  ["happy", "успех: 202 x2, потом 200, подписка активна"],
  ["no_sub", "подписки нет (200 has_subscription=false)"],
  ["revoked", "ссылка отозвана (пустая строка)"],
  ["expired", "подписка истекла"],
  ["poll_gone", "410 при опросе"],
  ["poll_forbidden", "403 аккаунт неактивен"],
  ["poll_422_array", "422 с detail-массивом"],
  ["poll_500_html", "500 с HTML вместо JSON"],
  ["poll_429_recover", "429 дважды, потом успех"],
  ["req_429", "429 на запросе токена"],
  ["req_botmissing", "503 Bot not configured"],
  ["timeout", "человек не подтвердил (TTL 6 c)"]
]

async function setScenario(name: string): Promise<void> {
  await fetch(`${BASE}/__scenario`, { method: "POST", body: JSON.stringify({ scenario: name }) })
}

async function statsHits(): Promise<number> {
  const r = await fetch(`${BASE}/__stats`, { method: "POST", body: "{}" })
  return ((await r.json()) as { hits: number }).hits
}

async function main(): Promise<void> {
  // Защита от того, что уже один раз случилось: если клиент собран без
  // переопределения адреса, он пойдёт в боевой кабинет, а не в заглушку.
  const before = await statsHits()
  await setScenario("happy")
  try {
    await runSubscriptionConnect(() => {})
  } catch {
    // неважно, нас интересует только факт обращения
  }
  if ((await statsHits()) === before) {
    console.error("СТОП: заглушка не получила ни одного запроса — клиент идёт мимо неё.")
    console.error("Проверьте SLAVANET_CABINET_BASE и что на машине лежит свежий connect.ts.")
    process.exit(2)
  }
  console.log("заглушка принимает запросы, начинаю матрицу")

  for (const [name, desc] of SCENARIOS) {
    await setScenario(name)
    const steps: string[] = []
    const started = Date.now()
    let outcome = ""
    try {
      const r = await runSubscriptionConnect((p) => {
        steps.push(p.status + (p.message ? `(${p.message})` : ""))
      })
      outcome = `УСПЕХ url=${r.url} name=${r.name ?? "-"}`
    } catch (e) {
      outcome = `ОТКАЗ: ${e instanceof Error ? e.message : String(e)}`
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\n[${name}] ${desc}`)
    console.log(`  шаги:  ${steps.join(" -> ")}`)
    console.log(`  итог:  ${outcome}   (${secs} c)`)
  }
}
main()
