import { getStore } from "@netlify/blobs";
import webpush from "web-push";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

type PushSubscriptionLike = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

type PushPayload = {
  title: string;
  body: string;
  tag?: string;
  url?: string;
};

function getEnv(name: string) {
  return Netlify.env.get(name) || "";
}

function pushStore() {
  return getStore({ name: "push-subscriptions", consistency: "strong" });
}

export function pushConfig() {
  const publicKey = getEnv("VAPID_PUBLIC_KEY");
  const privateKey = getEnv("VAPID_PRIVATE_KEY");
  const subject = getEnv("VAPID_SUBJECT") || "https://painel-bilhetes-setedmsk.netlify.app";
  return {
    publicKey,
    privateKey,
    subject,
    configured: Boolean(publicKey && privateKey),
  };
}

export function configureWebPush() {
  const config = pushConfig();
  if (!config.configured) return config;
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return config;
}

async function subscriptionId(endpoint: string) {
  const bytes = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isValidSubscription(subscription: PushSubscriptionLike) {
  return Boolean(
    subscription?.endpoint &&
    subscription?.keys?.p256dh &&
    subscription?.keys?.auth
  );
}

export async function savePushSubscription(subscription: PushSubscriptionLike) {
  if (!isValidSubscription(subscription)) {
    throw new Error("Inscricao push invalida.");
  }

  const id = await subscriptionId(String(subscription.endpoint));
  await pushStore().setJSON(`subscriptions/${id}.json`, {
    id,
    subscription,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

export async function deletePushSubscription(subscription: PushSubscriptionLike) {
  if (!subscription?.endpoint) return false;
  const id = await subscriptionId(String(subscription.endpoint));
  await pushStore().delete(`subscriptions/${id}.json`);
  return true;
}

export async function listPushSubscriptions() {
  const store = pushStore();
  const listed = await store.list({ prefix: "subscriptions/" });
  const records = [];

  for (const blob of listed.blobs || []) {
    try {
      const record = await store.get(blob.key, { type: "json" }) as any;
      if (record?.subscription && isValidSubscription(record.subscription)) {
        records.push(record);
      }
    } catch {
      // Ignore malformed subscriptions.
    }
  }

  return records;
}

export async function getPushSubscriptionById(id: string) {
  if (!id) return null;
  try {
    const record = await pushStore().get(`subscriptions/${id}.json`, { type: "json" }) as any;
    return record?.subscription && isValidSubscription(record.subscription) ? record.subscription : null;
  } catch {
    return null;
  }
}

export async function sendPushToAll(payload: PushPayload) {
  const config = configureWebPush();
  if (!config.configured) {
    return { sent: 0, failed: 0, skipped: true, reason: "VAPID ausente" };
  }

  const records = await listPushSubscriptions();
  let sent = 0;
  let failed = 0;

  for (const record of records) {
    try {
      await webpush.sendNotification(record.subscription, JSON.stringify(payload));
      sent += 1;
    } catch (error: any) {
      failed += 1;
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await pushStore().delete(`subscriptions/${record.id}.json`);
      }
    }
  }

  return { sent, failed, skipped: false };
}

export async function sendPushToSubscription(
  subscription: PushSubscriptionLike,
  payload: PushPayload
) {
  if (!isValidSubscription(subscription)) {
    throw new Error("Inscricao push invalida.");
  }

  const config = configureWebPush();
  if (!config.configured) {
    return { sent: 0, failed: 0, skipped: true, reason: "VAPID ausente" };
  }

  await webpush.sendNotification(subscription, JSON.stringify(payload));
  return { sent: 1, failed: 0, skipped: false };
}
