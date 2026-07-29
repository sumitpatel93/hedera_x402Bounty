import bs58 from "bs58";
import {
  Client,
  PrivateKey,
  PublicKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { config } from "../config.js";

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
}

export interface DidTopicEnvelope {
  operation: "create" | "update" | "delete" | "vc-issue" | "vc-revoke";
  did: string;
  event: string; // base64 JSON payload, meaning depends on `operation`
  signature: string; // base64 signature over the raw `event` bytes (pre-base64)
  timestamp: string;
}

export interface ResolvedDid {
  did: string;
  topicId: string;
  publicKey: PublicKey;
  document: DidDocument | null;
  deactivated: boolean;
  events: Array<{ consensusTimestamp: string; envelope: DidTopicEnvelope }>;
}

function multibasePublicKey(publicKey: PublicKey): string {
  return `z${bs58.encode(publicKey.toBytesRaw())}`;
}

function publicKeyFromMultibase(mb: string): PublicKey {
  if (!mb.startsWith("z")) throw new Error(`Unsupported multibase prefix in ${mb}`);
  const raw = bs58.decode(mb.slice(1));
  return PublicKey.fromBytesED25519(raw);
}

export function parseDid(did: string): { network: string; publicKeyMultibase: string; topicId: string } {
  const m = did.match(/^did:hedera:(testnet|mainnet):([^_]+)_(\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`Not a valid did:hedera identifier: ${did}`);
  return { network: m[1], publicKeyMultibase: m[2], topicId: m[3] };
}

function buildDidDocument(did: string, publicKey: PublicKey): DidDocument {
  const keyId = `${did}#did-root-key`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: multibasePublicKey(publicKey),
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
}

function signEnvelopeEvent(ownerKey: PrivateKey, operation: DidTopicEnvelope["operation"], did: string, eventJson: unknown): DidTopicEnvelope {
  const eventBytes = Buffer.from(JSON.stringify(eventJson));
  const signature = ownerKey.sign(eventBytes);
  return {
    operation,
    did,
    event: eventBytes.toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Creates a fresh HCS topic to serve as the DID's event log, publishes the
 * initial DID Document to it, and returns the resulting did:hedera identifier.
 */
export async function createDid(client: Client, ownerKey: PrivateKey): Promise<{ did: string; topicId: string; document: DidDocument }> {
  const topicTx = await new TopicCreateTransaction()
    .setSubmitKey(ownerKey.publicKey)
    .setAdminKey(ownerKey.publicKey)
    .setTopicMemo("did:hedera identity event log")
    .execute(client);
  const topicReceipt = await topicTx.getReceipt(client);
  const topicId = topicReceipt.topicId;
  if (!topicId) throw new Error("Topic creation did not return a topic id");

  const did = `did:hedera:${config.network}:${multibasePublicKey(ownerKey.publicKey)}_${topicId.toString()}`;
  const document = buildDidDocument(did, ownerKey.publicKey);

  const envelope = signEnvelopeEvent(ownerKey, "create", did, document);
  const submitTx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(envelope))
    .execute(client);
  await submitTx.getReceipt(client);

  return { did, topicId: topicId.toString(), document };
}

/**
 * Publishes an arbitrary signed event (e.g. a VC issuance/revocation record)
 * onto an existing DID's HCS topic. `ownerKey` must be the topic's submit key.
 */
export async function publishDidEvent(
  client: Client,
  topicId: string,
  ownerKey: PrivateKey,
  operation: DidTopicEnvelope["operation"],
  did: string,
  eventPayload: unknown,
): Promise<void> {
  const envelope = signEnvelopeEvent(ownerKey, operation, did, eventPayload);
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(JSON.stringify(envelope))
    .execute(client);
  await tx.getReceipt(client);
}

interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string; // base64
  chunk_info?: {
    initial_transaction_id: { account_id: string; transaction_valid_start: string };
    number: number;
    total: number;
  };
}

interface ReassembledMessage {
  consensusTimestamp: string;
  bytes: Buffer;
}

/**
 * HCS caps a single consensus message; the SDK auto-chunks anything larger
 * (our DID documents and VCs routinely are) across multiple mirror node
 * messages sharing one `chunk_info.initial_transaction_id`. Reassemble those
 * before treating a message as a complete JSON envelope.
 */
function reassembleChunkedMessages(raw: MirrorTopicMessage[]): ReassembledMessage[] {
  const groups = new Map<string, { total: number; chunks: Map<number, { ts: string; bytes: Buffer }> }>();
  const singles: ReassembledMessage[] = [];

  for (const msg of raw) {
    const bytes = Buffer.from(msg.message, "base64");
    if (!msg.chunk_info) {
      singles.push({ consensusTimestamp: msg.consensus_timestamp, bytes });
      continue;
    }
    const key = `${msg.chunk_info.initial_transaction_id.account_id}-${msg.chunk_info.initial_transaction_id.transaction_valid_start}`;
    const group = groups.get(key) ?? { total: msg.chunk_info.total, chunks: new Map() };
    group.chunks.set(msg.chunk_info.number, { ts: msg.consensus_timestamp, bytes });
    groups.set(key, group);
  }

  const reassembled: ReassembledMessage[] = [...singles];
  for (const group of groups.values()) {
    if (group.chunks.size !== group.total) continue; // incomplete group, skip
    const ordered = [...group.chunks.entries()].sort(([a], [b]) => a - b);
    reassembled.push({
      consensusTimestamp: ordered[0][1].ts,
      bytes: Buffer.concat(ordered.map(([, c]) => c.bytes)),
    });
  }

  reassembled.sort((a, b) => (a.consensusTimestamp < b.consensusTimestamp ? -1 : 1));
  return reassembled;
}

async function fetchTopicMessages(topicId: string): Promise<ReassembledMessage[]> {
  const messages: MirrorTopicMessage[] = [];
  let path: string | null = `/api/v1/topics/${topicId}/messages?order=asc&limit=100`;

  while (path) {
    const res = await fetch(`${config.mirrorNodeUrl}${path}`);
    if (!res.ok) throw new Error(`Mirror node error fetching topic ${topicId}: ${res.status}`);
    const body = (await res.json()) as { messages: MirrorTopicMessage[]; links?: { next?: string | null } };
    messages.push(...(body.messages ?? []));
    path = body.links?.next ?? null;
  }

  return reassembleChunkedMessages(messages);
}

/**
 * Resolves a did:hedera identifier by replaying its HCS topic through the
 * mirror node and verifying every event's signature against the key embedded
 * in the DID itself (never against a key found in the message).
 */
export async function resolveDid(did: string): Promise<ResolvedDid> {
  const { topicId, publicKeyMultibase } = parseDid(did);
  const publicKey = publicKeyFromMultibase(publicKeyMultibase);
  const messages = await fetchTopicMessages(topicId);

  let document: DidDocument | null = null;
  let deactivated = false;
  const events: ResolvedDid["events"] = [];

  for (const msg of messages) {
    let envelope: DidTopicEnvelope;
    try {
      envelope = JSON.parse(msg.bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (envelope.did !== did) continue;

    const eventBytes = Buffer.from(envelope.event, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    if (!publicKey.verify(eventBytes, signature)) continue; // ignore forged/unsigned events

    events.push({ consensusTimestamp: msg.consensusTimestamp, envelope });

    if (envelope.operation === "create" || envelope.operation === "update") {
      document = JSON.parse(eventBytes.toString("utf8"));
      deactivated = false;
    } else if (envelope.operation === "delete") {
      deactivated = true;
    }
  }

  return { did, topicId, publicKey, document, deactivated, events };
}
