/**
 * Pack registry types — Phase 1 (local content-pack lifecycle) of the
 * approved #28 design (docs/refactor/PACK_REGISTRY_DESIGN.md). A pack is a
 * signed, versioned bundle of artifacts that installs into the stores the
 * runtime already loads (personas/skills/workflows/knowledgebases); the pack
 * machinery adds distribution trust, provenance, and lifecycle — not a new
 * loading path.
 */

export type PackClass = "content" | "agent";
export type PackTier = "free" | "paid" | "enterprise";
export type PackReviewStatus = "reviewed" | "unreviewed" | "revoked";

export type PackManifest = {
  schemaVersion: number;
  /** <publisher>/<name>; both segments [a-z0-9-]{1,64}. */
  id: string;
  class: PackClass;
  name: string;
  description?: string;
  /** SemVer 2.0.0. */
  version: string;
  license?: string;
  publisher?: { id: string; name?: string; url?: string };
  tier?: PackTier;
  engines?: { mindstone?: string };
  /** Pack id -> SemVer range (flat; design D5). */
  dependencies?: Record<string, string>;
  artifacts: {
    personas?: string[];
    skills?: string[];
    workflows?: string[];
    knowledgebases?: string[];
    /** Archive-relative dir of first-install-only memory seeds. */
    memorySeeds?: string;
    /** Agent class only. */
    identitySeed?: string;
  };
  /** Agent class only; content packs MUST omit (design §4 invariant). */
  runtime?: {
    requires?: Record<string, string>;
    image?: { ref: string; cosignSigned?: boolean };
    compose?: string;
    webChat?: boolean;
    gateway?: boolean;
    synapse?: string;
  };
  security?: {
    defaultToolPolicy?: string;
    networkPolicy?: string;
    requiresEntitlement?: boolean;
  };
  safety: {
    reviewStatus: PackReviewStatus;
    reviewedBy?: string;
    reviewedAt?: string;
    reviewId?: string;
    /** Versioned prompt-surface derivation rule (design §4; rule 1 supported). */
    promptSurfacesRule: number;
    /** Every prompt-bearing markdown file, build-time derived, install-time re-derived. */
    promptSurfaces: string[];
    riskNotes?: string[];
    boundaries?: string[];
  };
  updates?: { channel?: "stable" | "beta" };
  /** Name of the per-file digest list at archive root. */
  files: string;
  createdAt?: string;
};

export type PackFileStatus = "owned" | "user-modified" | "user-deleted" | "conflict";

export type PackReceiptFile = {
  /** Path relative to dataDir (the live store location). */
  storePath: string;
  /** Path inside the archive. */
  archivePath: string;
  sha256AtInstall: string;
  currentStatus: PackFileStatus;
  /** Present when an update wrote a .pack-new alongside a user-modified file. */
  incomingSha256?: string;
};

export type PackReceipt = {
  packId: string;
  version: string;
  archiveDigest: string;
  installedAt: string;
  updatedAt?: string;
  trusted: boolean;
  revokedOverride?: boolean;
  depsBroken?: boolean;
  /** ISO timestamp of the one-time memory-seed application (first install only). */
  seededAt?: string;
  seededFiles?: string[];
  files: PackReceiptFile[];
};

export type PackLockEntry = {
  id: string;
  version: string;
  digest: string;
  registryId?: string;
  installedAt: string;
  trusted: boolean;
  channel?: string;
};

export type PackLock = {
  schemaVersion: number;
  packs: PackLockEntry[];
};

export type PublisherKey = {
  /** Key id for display, e.g. "mindstone-2026a". */
  keyId: string;
  publisherId: string;
  /** "ed25519:<base64 raw 32-byte public key>" */
  publicKey: string;
  expiresAt?: string;
  revoked?: boolean;
};

export type PackTrustStore = {
  schemaVersion: number;
  publishers: PublisherKey[];
};

export type MindStonePacksConfigSection = {
  /** Override the packs state directory (defaults to <dataDir>/packs). */
  dir?: string;
  /** Dev escape hatch, default OFF. Unsigned installs also require --unsigned. */
  allowUnsigned?: boolean;
  /** Require confirm/--accept-unreviewed for unreviewed packs (default true). */
  confirmUnreviewed?: boolean;
};
