// Sends a push notification to the other members of the player's groups when a game is saved.
// Called by the database (private.announce_result) with the shared x-parle-secret header.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get("VAPID_KEYS")!), { extractable: false });
const appServer = await webpush.ApplicationServer.new({
  contactInformation: "https://giannipie.github.io/wordle-it/",
  vapidKeys,
});

Deno.serve(async (req) => {
  if (req.headers.get("x-parle-secret") !== Deno.env.get("NOTIFY_SECRET")) return new Response("forbidden", { status: 403 });
  const { user_id, day, urgency } = await req.json();
  // Normally high; "normal" only for a test sent by hand from the database.
  const level = urgency === "normal" ? webpush.Urgency.Normal : webpush.Urgency.High;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb.rpc("notification_payload", { p_user: user_id, p_day: day });
  if (error || !data) return Response.json({ error: error?.message || "no result" }, { status: 500 });

  let sent = 0, gone = 0, failed = 0;
  for (const r of data.recipients as { endpoint: string; keys: { p256dh: string; auth: string }; site: string; group: string }[]) {
    const message = JSON.stringify({
      title: data.title,
      body: data.body,
      url: `${r.site.replace(/\/$/, "")}/classifica/?chat=${r.group}`,
      tag: `parle-${user_id}-${day}`,
    });
    try {
      await appServer.subscribe({ endpoint: r.endpoint, keys: r.keys }).pushTextMessage(message, {
        ttl: 24 * 3600,
        urgency: level, // high: delivered at once, also with the phone locked (not held until it wakes up)
      });
      sent++;
    } catch (e) {
      // The device unsubscribed or the app was removed: forget it.
      const status = (e as { response?: Response }).response?.status;
      if (status === 404 || status === 410) {
        await sb.rpc("forget_push_subscription", { p_endpoint: r.endpoint });
        gone++;
      } else failed++;
    }
  }
  return Response.json({ sent, gone, failed });
});
