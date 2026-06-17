const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const zlib = require('zlib');

initializeApp();

// Co-locate with Firestore (asia-southeast1 = Jakarta) for lowest latency.
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });

const db = getFirestore();

// Slugs that collide with system paths in Firebase Hosting rewrites / the
// client-side tenant resolver. Blocking these is a *technical* requirement —
// allowing them would break the site for that tenant.
//
// `jsminimart` is also reserved per Jason's instruction (existing seed tenant).
// Superadmin emails — bypass the per-email tenant cap. Keep in sync with
// firestore.rules isSuperadmin() and admin.html SUPERADMIN_EMAILS.
const SUPERADMIN_EMAILS = new Set([
  'aws.jason.b.tubilag@gmail.com',
  'jason.b.tubilag@gmail.com',
  'manilynp07@gmail.com'
]);

// Max tenants a single non-superadmin email can create. Pilot default = 1.
// Industry standard for free SaaS tiers; easier to relax later than tighten.
const MAX_TENANTS_PER_EMAIL = 1;

const RESERVED_SLUGS = new Set([
  'admin', 'admin.html',
  'checkout', 'checkout.html',
  'signup', 'login', 'logout',
  'superadmin', 'api',
  'assets', 'static', 'public',
  'www', 'mail', 'ftp',
  'manifest.json', 'sw.js', 'firebase.json',
  'logo.png', 'newlogo.jpeg',
  'index.html', 'index', '__',
  'jsminimart'
]);

// Slugs held for the platform admins (SUPERADMIN_EMAILS) only — blocked for
// every other signup. Covers the exact slugs below PLUS anything spelling the
// brand "pabilimart" (hyphens ignored). Lets us pre-reserve store URLs before
// an owner signs up. Email compared case-insensitively.
const ADMIN_RESERVED_SLUGS = new Set([
  'tindahan-ni-jason',
  'tindahan-ni-manilyn',
  'tindahan-ni-jacob',
  'tindahan-ni-sabrina',
  'catalog-store', // internal master catalog (forever Pro) — see seedCatalogStore
  // "Jason" + slug variants of "Jason's Store" (apostrophe/space can't be in a
  // slug). Exact-match only, so names like jason-cruz / jason-bakery stay open.
  'jason',
  'jasons-store',
  'jasonsstore',
  'jason-store',
  'jasonstore',
]);
function isAdminReservedSlug(slug) {
  if (ADMIN_RESERVED_SLUGS.has(slug)) return true;
  // Brand protection: any slug whose letters spell "...pabilimart..." once
  // hyphens are stripped — catches pabilimart, pabili-mart, admin-pabilimart,
  // pabilimart-store, official-pabilimart-store, etc. "pabili" alone (a common
  // Filipino word) is NOT blocked.
  return slug.replace(/-/g, '').includes('pabilimart');
}

// Store NAMES reserved for the platform admins (superadmins) only. Compared on
// a normalized form (lowercased, non-alphanumerics stripped) so spacing,
// apostrophes, and casing don't matter: "Jason's Store" == "Jasons Store" ==
// "jasonsstore". Covers the exact names below PLUS any name spelling the brand
// "pabilimart". Unrelated names (e.g. "Jason Cruz Store") stay open.
const ADMIN_RESERVED_NAMES = new Set([
  'jason',
  'jasonsstore',
]);
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isAdminReservedName(name) {
  const n = normalizeName(name);
  if (ADMIN_RESERVED_NAMES.has(n)) return true;
  return n.includes('pabilimart'); // brand protection (matches the slug rule)
}

// Lowercase letters/numbers/hyphens, must start with a letter, 3–32 chars.
// No trailing hyphen, no consecutive hyphens.
const SLUG_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLUG_MIN = 3;
const SLUG_MAX = 32;

function validateSlug(raw, callerEmail) {
  const slug = String(raw || '').trim().toLowerCase();
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    throw new HttpsError('invalid-argument',
      `Store URL must be ${SLUG_MIN}–${SLUG_MAX} characters.`);
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new HttpsError('invalid-argument',
      'Store URL can only contain lowercase letters, numbers, and single hyphens, and must start with a letter.');
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new HttpsError('already-exists',
      'That store URL is reserved. Please choose another.');
  }
  // Admin-reserved (exact slug or brand "pabilimart"): only superadmins claim it.
  if (isAdminReservedSlug(slug) &&
      !SUPERADMIN_EMAILS.has(String(callerEmail || '').trim().toLowerCase())) {
    throw new HttpsError('already-exists',
      'That store URL is reserved. Please choose another.');
  }
  return slug;
}

function validateName(raw, callerEmail) {
  const name = String(raw || '').trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpsError('invalid-argument',
      'Store name must be 2–100 characters.');
  }
  // Admin-reserved name (exact normalized, or brand "pabilimart"): superadmins only.
  if (isAdminReservedName(name) &&
      !SUPERADMIN_EMAILS.has(String(callerEmail || '').trim().toLowerCase())) {
    throw new HttpsError('already-exists',
      'That store name is reserved. Please choose another.');
  }
  return name;
}

function validatePickupAddress(raw) {
  const v = String(raw || '').trim();
  if (v.length < 5 || v.length > 300) {
    throw new HttpsError('invalid-argument',
      'Pickup address must be 5–300 characters.');
  }
  return v;
}

function validateGcashAccountName(raw) {
  const v = String(raw || '').trim();
  if (v.length < 2 || v.length > 100) {
    throw new HttpsError('invalid-argument',
      'GCash account name must be 2–100 characters.');
  }
  return v;
}

function validateGcashNumber(raw) {
  const v = String(raw || '').trim();
  if (!/^09\d{9}$/.test(v)) {
    throw new HttpsError('invalid-argument',
      'GCash number must be 11 digits starting with 09.');
  }
  return v;
}

// ============================================================
// Invite-code helpers
// ============================================================
// Codes are 8 chars from an unambiguous alphabet (no 0/O/1/I) so they're
// easy to share verbally / via SMS without confusion.
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomInviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += INVITE_CODE_ALPHABET.charAt(Math.floor(Math.random() * INVITE_CODE_ALPHABET.length));
  }
  return s;
}
function normalizeInviteCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ============================================================
// Public directory helpers
// ============================================================
// `public/directory` is the single source of truth for the signup-page
// store-finder. Anonymous customers read it to discover storefronts by name.
// Kept in sync from createTenant (add entry) and deleteTenant (remove entry).
// `rebuildPublicDirectory` rescans all tenants from scratch — used for
// recovery and one-time backfill after this feature shipped.
const PUBLIC_DIRECTORY_REF = () => db.collection('public').doc('directory');

async function upsertDirectoryEntry(slug, name) {
  await PUBLIC_DIRECTORY_REF().set({
    stores: FieldValue.arrayUnion({ slug, name }),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// ============================================================
// Subscription tiers — single source of truth used by createTenant
// (seeding new tenants) and the lifecycle / billing flows.
// Phase-A scope: schema only. Phase-D will enforce caps server-side.
// ============================================================
const SUBSCRIPTION_TIERS = {
  free:   { name: 'PabiliMart Free',   amount: 0,   productCap: 5 },
  growth: { name: 'PabiliMart Growth', amount: 149, productCap: 500 },
  pro:    { name: 'PabiliMart Pro',    amount: 499, productCap: 6000 }
};

// First month free across all paid tiers + the Free tier is permanently free.
// Trial duration in days. Apply only to PAID tiers via getInitialSubscription.
const FREE_TRIAL_DAYS = 30;

function getInitialSubscription({ tier = 'free' } = {}) {
  const tierConfig = SUBSCRIPTION_TIERS[tier] || SUBSCRIPTION_TIERS.free;
  const now = new Date();
  if (tier === 'free') {
    // Free tier doesn't trial — it's permanently free. trialUsedAt stays
    // null so this tenant can later claim a trial on first paid upgrade.
    return {
      tier: 'free',
      status: 'active',
      amount: 0,
      currentPeriodStart: FieldValue.serverTimestamp(),
      currentPeriodEnd: null, // no renewal needed
      trialEndsAt: null,
      trialUsedAt: null,
      pastDueSince: null,
      suspendedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      paymentMethod: null,
      createdAt: FieldValue.serverTimestamp()
    };
  }
  // Paid tier at signup: 30-day trial. trialUsedAt is set immediately —
  // the one-trial-per-tenant entitlement is consumed by this signup.
  const trialEnd = new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return {
    tier,
    status: 'trialing',
    amount: tierConfig.amount,
    currentPeriodStart: FieldValue.serverTimestamp(),
    currentPeriodEnd: trialEnd, // trial ends here unless first payment lands
    trialEndsAt: trialEnd,
    trialUsedAt: FieldValue.serverTimestamp(),
    pastDueSince: null,
    suspendedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    paymentMethod: 'manual_gcash', // MVP default
    createdAt: FieldValue.serverTimestamp()
  };
}

async function removeDirectoryEntry(slug) {
  // arrayRemove needs the exact object; we don't store the name authoritatively
  // here, so re-read and filter instead.
  const snap = await PUBLIC_DIRECTORY_REF().get();
  if (!snap.exists) return;
  const stores = (snap.data() || {}).stores || [];
  const next = stores.filter(s => s && s.slug !== slug);
  await PUBLIC_DIRECTORY_REF().set({
    stores: next,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// ============================================================
// injectStarterCatalog — copy the JS Mini Mart catalog into a Pro tenant as a
// HIDDEN starter catalog the owner curates. Runs at most ONCE per tenant,
// guarded by `starterCatalogInjected` on the tenant root doc (so
// Pro→Growth→Pro never duplicates). Triggers: Pro signup (createTenant) and
// reaching Pro via payment (confirmManualPayment).
//
// Each product is copied with a FRESH id (never clobbers the tenant's own
// products), hidden:true + archived:false (invisible on the storefront until
// the owner flips the per-row hide toggle), and tagged fromStarterCatalog:true.
// Image URLs are REFERENCED (public download-token URLs), not re-uploaded — so
// if JS Mini Mart later deletes a source image the copy shows a broken image
// until the owner re-uploads (their edits write to their own storage path).
// Branch-scoped fields are dropped so injected items are plain shared products.
// Callers wrap this best-effort: a failure never blocks signup/payment.
// ============================================================
// The master reference catalog new subscribers are copied from. Seeded once
// from jsminimart via seedCatalogStore(), then curated independently — so
// catalog changes only affect FUTURE subscribers, never existing stores.
const STARTER_CATALOG_SOURCE_TID = 'catalog-store';
// Tenants that must NEVER receive an injection: the master itself + jsminimart
// (the original real shop, whose own catalog must not be duplicated into it).
const INJECT_EXCLUDED_TIDS = new Set(['catalog-store', 'jsminimart']);

async function injectStarterCatalog(tid) {
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) return { injected: 0, skipped: 'no-tenant' };
  if ((tsnap.data() || {}).starterCatalogInjected === true) {
    return { injected: 0, skipped: 'already-injected' };
  }
  if (INJECT_EXCLUDED_TIDS.has(tid)) return { injected: 0, skipped: 'excluded' };

  const srcSnap = await db.collection('tenants').doc(STARTER_CATALOG_SOURCE_TID)
    .collection('products').get();
  if (srcSnap.empty) return { injected: 0, skipped: 'empty-source' };

  const targetCol = tref.collection('products');
  const base = Date.now();
  let batch = db.batch(), ops = 0, injected = 0, i = 0;
  for (const doc of srcSnap.docs) {
    const src = doc.data() || {};
    const newId = base + i; i++;
    const out = { ...src, id: newId, hidden: true, archived: false, fromStarterCatalog: true };
    delete out.branchIds;       // not tied to this tenant's branches
    delete out.branchInventory; // branch-scoped stock, if any
    batch.set(targetCol.doc(String(newId)), out);
    ops++; injected++;
    // Conservative batch size — most images are URLs now, but stay well under
    // Firestore's 10MB/batch ceiling in case any source doc still carries base64.
    if (ops >= 200) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) await batch.commit();
  await tref.update({
    starterCatalogInjected: true,
    starterCatalogInjectedAt: FieldValue.serverTimestamp(),
    starterCatalogCount: injected
  });
  return { injected };
}

// ============================================================
// seedCatalogStore — one-time bootstrap of the master `catalog-store` tenant:
//   1. Copy jsminimart's current catalog into catalog-store (master copy,
//      original ids kept, visible — this is the curate-here reference set).
//   2. Make catalog-store FOREVER Pro: tier=pro, status=active, amount=0,
//      currentPeriodEnd=null (so runSubscriptionLifecycle never expires it),
//      trialUsedAt set so it can't claim a trial.
// Guarded: refuses to overwrite an already-populated catalog-store unless
// force:true — so a curated master is never silently clobbered.
// ============================================================
const CATALOG_STORE_TID = 'catalog-store';
const CATALOG_SEED_SOURCE_TID = 'jsminimart';

// setTenantForeverPro — pin a tenant to Pro permanently: internal (amount 0),
// active, currentPeriodEnd=null so runSubscriptionLifecycle never expires or
// downgrades it, and no trial/grace/dunning. Used for catalog-store and any
// owner-internal store (e.g. jsminimart). Does NOT touch products or directory.
async function setTenantForeverPro(tid) {
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', `Tenant "${tid}" does not exist.`);
  await tref.collection('subscription').doc('current').set({
    tier: 'pro', status: 'active', amount: 0,
    currentPeriodStart: FieldValue.serverTimestamp(),
    currentPeriodEnd: null,
    trialEndsAt: null, trialUsedAt: FieldValue.serverTimestamp(),
    scheduledTier: null, graceSince: null, graceEndsAt: null,
    graceFromTier: null, graceToTier: null, pendingRetainIds: null,
    cancelAtPeriodEnd: false, dunningStages: [],
    paymentMethod: 'internal', internalForeverPro: true
  }, { merge: true });
  await tref.set({ tier: 'pro' }, { merge: true });
  await tref.collection('settings').doc('store').set({ tier: 'pro' }, { merge: true });
  return { tid, tier: 'pro', foreverPro: true };
}

async function seedCatalogStore({ force = false } = {}) {
  const cref = db.collection('tenants').doc(CATALOG_STORE_TID);
  const csnap = await cref.get();
  if (!csnap.exists) {
    throw new HttpsError('not-found', `Tenant "${CATALOG_STORE_TID}" does not exist — create it first.`);
  }

  // ALWAYS (idempotent): forever Pro + remove from the public store-finder
  // directory so catalog-store never surfaces to customers. Runs even on the
  // already-seeded skip path, so re-clicking the button enforces the lock.
  await setTenantForeverPro(CATALOG_STORE_TID);
  await cref.set({ internalCatalogStore: true }, { merge: true });
  let removedFromDirectory = false;
  try { await removeDirectoryEntry(CATALOG_STORE_TID); removedFromDirectory = true; }
  catch (err) { console.warn('[seedCatalogStore] directory remove failed:', err.message); }

  // Products: copy from jsminimart only if catalog-store is empty (or forced).
  const targetCol = cref.collection('products');
  const existing = await targetCol.limit(1).get();
  if (!existing.empty && !force) {
    return { skipped: 'already-seeded', tier: 'pro', removedFromDirectory };
  }

  // Copy jsminimart catalog → catalog-store (master; keep ids; not archived).
  const srcSnap = await db.collection('tenants').doc(CATALOG_SEED_SOURCE_TID).collection('products').get();
  let batch = db.batch(), ops = 0, copied = 0;
  for (const doc of srcSnap.docs) {
    const out = { ...(doc.data() || {}) };
    delete out.fromStarterCatalog; // this IS the master, not an injected copy
    delete out.archived;           // master is never tier-archived
    batch.set(targetCol.doc(doc.id), out, { merge: true });
    ops++; copied++;
    if (ops >= 200) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) await batch.commit();

  return { seeded: true, copied, forced: force, tier: 'pro', removedFromDirectory };
}

exports.createTenant = onCall(async (request) => {
  // ---------- AUTH ----------
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to create a store.');
  }
  const token = request.auth.token || {};
  if (token.email_verified !== true) {
    throw new HttpsError('failed-precondition',
      'Your email must be verified. Sign in with Google to continue.');
  }
  const email = token.email;
  const uid = request.auth.uid;
  if (!email) {
    throw new HttpsError('failed-precondition', 'No email on your account.');
  }

  // ---------- INPUT VALIDATION ----------
  const data = request.data || {};
  const slug = validateSlug(data.slug, email);
  const name = validateName(data.name, email);
  const pickupAddress = validatePickupAddress(data.pickupAddress);
  const gcashAccountName = validateGcashAccountName(data.gcashAccountName);
  const gcashNumber = validateGcashNumber(data.gcashNumber);
  // Tier picked on the signup page. Default to Free for any value we don't
  // recognize so a corrupt payload can't bypass the trial entitlement.
  const requestedTier = String(data.tier || '').trim();
  const initialTier = SUBSCRIPTION_TIERS[requestedTier] ? requestedTier : 'free';

  // ---------- INVITE-CODE GATE (non-superadmin only) ----------
  // Self-serve signup requires a valid invite code minted by a superadmin.
  // Superadmins bypass — they can spin up tenants directly without a code.
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);
  const inviteCode = normalizeInviteCode(data.inviteCode);
  // Signup is OPEN: invite codes are now an optional attribution layer, not
  // a gate. If a code is provided we validate + redeem it (still useful for
  // marketing attribution + Phase 8 paid-tier perks). If empty, skip the
  // lookup entirely — the per-email cap below is the spam ceiling.
  let inviteRef = null;
  let inviteSnap = null;
  if (!isSuperadmin && inviteCode) {
    inviteRef = db.collection('invite_codes').doc(inviteCode);
    inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      throw new HttpsError('not-found',
        'That invite code doesn\'t exist. Double-check the code and try again, or leave the field blank.');
    }
    const inv = inviteSnap.data() || {};
    if (inv.revoked === true) {
      throw new HttpsError('failed-precondition',
        'That invite code has been revoked. Leave it blank or contact support for a new one.');
    }
    if (inv.redeemedAt) {
      throw new HttpsError('failed-precondition',
        'That invite code has already been used. Leave it blank to sign up without a code.');
    }
    if (inv.email && String(inv.email).toLowerCase() !== email.toLowerCase()) {
      throw new HttpsError('permission-denied',
        `That invite code is bound to a different email address (${inv.email}). Sign in with that account, or leave the field blank.`);
    }
  }

  // ---------- PER-EMAIL TENANT CAP ----------
  // Note: this check is racy under high-concurrency parallel calls from the
  // same user; acceptable for pilot scale.
  if (!isSuperadmin) {
    const existing = await db.collection('tenants')
      .where('createdByEmail', '==', email)
      .limit(MAX_TENANTS_PER_EMAIL + 1)
      .get();
    if (existing.size >= MAX_TENANTS_PER_EMAIL) {
      const noun = MAX_TENANTS_PER_EMAIL === 1 ? 'store' : 'stores';
      throw new HttpsError('resource-exhausted',
        `Each Google account can create up to ${MAX_TENANTS_PER_EMAIL} ${noun}, and you've already used yours. Switch to a different Google account to create another, or contact support.`);
    }
  }

  // ---------- CREATE (transactional uniqueness + invite redemption) ----------
  const ref = db.collection('tenants').doc(slug);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      throw new HttpsError('already-exists', 'That store URL is already taken.');
    }
    // Re-read the invite under the transaction so a parallel redemption
    // can't slip through between the pre-check above and the create.
    if (inviteRef) {
      const freshInv = await tx.get(inviteRef);
      if (!freshInv.exists) throw new HttpsError('not-found', 'Invite code disappeared.');
      const fd = freshInv.data() || {};
      if (fd.revoked === true) throw new HttpsError('failed-precondition', 'Invite code was just revoked.');
      if (fd.redeemedAt) throw new HttpsError('failed-precondition', 'Invite code was just used by another account.');
      tx.update(inviteRef, {
        redeemedAt: FieldValue.serverTimestamp(),
        redeemedBy: email,
        redeemedSlug: slug
      });
    }
    tx.set(ref, {
      name,
      ownerEmails: [email],
      plan: 'starter',
      // Tier mirror on the root tenant doc — the superadmin tenants table
      // reads this in the paginated list query so the Plan column doesn't
      // cost a per-row subscription read. Kept in sync by createTenant,
      // confirmManualPayment, startFreeTrial, and backfillSubscriptions.
      tier: initialTier,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
      createdByEmail: email,
      inviteCode: inviteCode || null
    });
  });

  // ---------- SEED SETTINGS DOC ----------
  // Tenant-facing configuration that the (anonymous) storefront and
  // checkout pages read. Editable later via admin → Settings.
  await ref.collection('settings').doc('store').set({
    storeClosed: false,
    rainMode: false,
    maintenanceMode: false,
    storeClosedSource: 'auto',
    storeName: name,
    pickupAddress,
    gcashAccountName,
    gcashNumber,
    // Storefront layout — 'grid' (default, retail style) or 'list'
    // (FoodPanda-style stacked rows with description, for restaurants /
    // carinderias / cafés). Editable later in admin → Appearance.
    storefrontLayout: 'grid',
    // Service & payment defaults — new tenants start with everything ON.
    deliveryEnabled: true,
    pickupEnabled: true,
    payCashEnabled: true,
    payGcashEnabled: true,
    payCodEnabled: true,
    // Maximum cart total (PHP) for Cash on Delivery. 0 = no limit.
    // New tenants start with no COD limit; tenant can set one in admin.
    codMaxAmount: 0,
    // Operating hours (Manila time, 24h). Tenant edits these in admin → Store Info.
    storeOpenHour: 6,
    storeCloseHour: 16,
    // Open days of week (0=Sun, 6=Sat). Default: open every day.
    openDays: [0,1,2,3,4,5,6],
    // Delivery schedule windows. Off by default; tenant opts in via admin → Service & Payment.
    schedulesEnabled: false,
    deliverySchedules: [
      { start: '10:00', end: '14:00' },
      { start: '14:00', end: '18:00' },
      { start: '16:00', end: '19:00' }
    ],
    // Delivery fee — toggleable + configurable amount (PHP).
    // Off by default: new stores deliver free until the owner turns the fee on.
    deliveryFeeEnabled: false,
    deliveryFee: 45,
    // Free delivery promotion + delivery areas list — both toggleable.
    // Free-delivery-on-large-orders is off by default so every order pays the fee.
    freeDeliveryEnabled: false,
    freeDeliveryThreshold: 400,
    deliveryAreasEnabled: true,
    deliveryAreas: [],
    // Subscription tier mirror — public-readable copy of subscription.tier
    // so the customer-facing storefront can gate the "Powered by Pabili
    // Mart" footer on Free tier without relaxing the (private) subscription
    // doc rules. Kept in sync by confirmManualPayment + backfillSubscriptions.
    tier: initialTier
  });

  // ---------- SEED SUBSCRIPTION DOC ----------
  // Paid tiers (Growth/Pro) start in 'trialing' status for FREE_TRIAL_DAYS
  // via getInitialSubscription — it sets trialUsedAt to serverTimestamp so
  // the one-trial-per-tenant entitlement is consumed by this signup.
  await ref.collection('subscription').doc('current').set(getInitialSubscription({ tier: initialTier }));

  // ---------- COPY STARTER PACK PRODUCTS ----------
  // The root /starter_pack collection is curated by superadmin via the
  // "Seed Starter Pack" button in admin. If it's empty (i.e. no pack
  // seeded yet), new tenants start with an empty catalog — fine for pilot.
  let starterPackCopied = 0;
  try {
    const pack = await db.collection('starter_pack').get();
    if (!pack.empty) {
      const productsCol = ref.collection('products');
      let batch = db.batch();
      let ops = 0;
      for (const doc of pack.docs) {
        batch.set(productsCol.doc(doc.id), doc.data());
        ops++;
        // Small batch size keeps us comfortably under Firestore's 10MB
        // per-batch limit when products carry base64-image data.
        if (ops >= 20) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
      starterPackCopied = pack.size;
    }
  } catch (err) {
    // Don't fail tenant creation if starter pack copy fails — log and move on.
    console.error('starter_pack copy failed for tenant', slug, err);
  }

  // ---------- PRO STARTER CATALOG (hidden) ----------
  // Pro signups additionally get the full JS Mini Mart catalog injected as a
  // HIDDEN catalog to curate. The small starter_pack above stays as the
  // visible day-one set. Best-effort — never fails the signup.
  let starterCatalogInjected = 0;
  if (initialTier === 'pro') {
    try {
      const r = await injectStarterCatalog(slug);
      starterCatalogInjected = r.injected || 0;
    } catch (err) {
      console.error('starter catalog inject failed for tenant', slug, err);
    }
  }

  // ---------- ADD TO PUBLIC DIRECTORY ----------
  // Non-blocking: directory enables storefront discovery on the signup
  // page, but a failure here shouldn't roll back a successful tenant create.
  try {
    await upsertDirectoryEntry(slug, name);
  } catch (err) {
    console.error('public directory upsert failed for tenant', slug, err);
  }

  // Grant the creator a Storage-ownership claim for this tenant. Storage rules
  // read ownership from the token (not Firestore), so without this the owner
  // can't upload product images. Best-effort — never fail tenant creation over
  // it; backfillOwnerClaims can repair any gaps. The client force-refreshes its
  // token (handleAdminAuth) so the new claim takes effect without re-login.
  try {
    const u = await getAuth().getUser(uid);
    const claims = (u && u.customClaims) || {};
    const owned = Array.isArray(claims.tenants) ? claims.tenants : [];
    if (!owned.includes(slug)) {
      await getAuth().setCustomUserClaims(uid, { ...claims, tenants: [...owned, slug] });
    }
  } catch (err) {
    console.warn('[createTenant] setCustomUserClaims failed for', uid, ':', err && err.message);
  }

  return {
    slug,
    name,
    url: `https://pabilimart.com/${slug}/`,
    adminUrl: `https://pabilimart.com/${slug}/admin/`,
    starterPackCopied,
    starterCatalogInjected,
    tier: initialTier,
    tierName: SUBSCRIPTION_TIERS[initialTier].name,
    trialing: initialTier !== 'free'
  };
});

// ============================================================
// deleteTenant — superadmin-only, recursive delete of a tenant doc
// and all its subcollections (products / orders / settings / etc.)
// ============================================================
// ============================================================
// renameTenant — superadmin-only. Changes a tenant's display name
// across all three places it lives:
//   1. tenants/{tid}.name            (root tenant doc)
//   2. tenants/{tid}/settings/store.storeName (storefront header)
//   3. public/directory.stores[]     (signup-page store-finder)
//
// Slug is NEVER renamed — it's the Firestore doc ID, the URL path,
// and the join key in payments / public/directory. A slug change is
// effectively a delete-and-recreate (not exposed here).
//
// Tenant-side admin UI shows storeName as read-only (locked at signup);
// this function is the only path to update it. Surfaces in
// /superadmin/ as a Rename button on the tenant detail modal.
// ============================================================
exports.renameTenant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const token = request.auth.token || {};
  if (token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Email must be verified.');
  }
  if (!SUPERADMIN_EMAILS.has(token.email)) {
    throw new HttpsError('permission-denied', 'Superadmin only.');
  }

  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  // validateName trims, length-checks (2..100), and rejects non-printable
  // characters — same validation used at signup time.
  const newName = validateName(data.newName, token.email);

  const tref = db.collection('tenants').doc(tid);
  const settingsRef = tref.collection('settings').doc('store');

  // Tenant root doc + settings/store mirror updated atomically so the
  // storefront header (driven by settings/store snapshot) never lags
  // behind the directory or admin display name.
  await db.runTransaction(async (tx) => {
    const tsnap = await tx.get(tref);
    if (!tsnap.exists) {
      throw new HttpsError('not-found', `Tenant "${tid}" not found.`);
    }
    tx.update(tref, {
      name: newName,
      renamedAt: FieldValue.serverTimestamp(),
      renamedBy: token.email
    });
    // settings/store may not exist yet for legacy tenants — set merge
    // is safe either way.
    tx.set(settingsRef, { storeName: newName }, { merge: true });
  });

  // Public directory entry stores objects {slug, name}; arrayUnion can't
  // match by slug, so do a read-filter-rewrite. Non-fatal: if this fails
  // the tenant + settings rename still succeeded, and superadmin can run
  // rebuildPublicDirectory to recover.
  try {
    const dsnap = await PUBLIC_DIRECTORY_REF().get();
    if (dsnap.exists) {
      const stores = (dsnap.data() || {}).stores || [];
      const updated = stores.map(s =>
        s && s.slug === tid ? { slug: tid, name: newName } : s
      );
      await PUBLIC_DIRECTORY_REF().set({
        stores: updated,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    console.error('public directory rename failed for tenant', tid, err);
  }

  return { tid, newName, ok: true };
});

exports.deleteTenant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const token = request.auth.token || {};
  if (token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Email must be verified.');
  }
  if (!SUPERADMIN_EMAILS.has(token.email)) {
    throw new HttpsError('permission-denied', 'Superadmin only.');
  }

  const data = request.data || {};
  const slug = String(data.slug || '').trim().toLowerCase();
  if (!slug) throw new HttpsError('invalid-argument', 'slug is required');
  if (slug === 'jsminimart') {
    throw new HttpsError('failed-precondition',
      'Refusing to delete the seed tenant jsminimart. Edit functions/index.js to allow.');
  }

  const tref = db.collection('tenants').doc(slug);

  // Capture the owner email(s) BEFORE deleting the doc — we need them to also
  // remove the owner's Firebase Auth login. With MAX_TENANTS_PER_EMAIL = 1 the
  // owner has no other store, so the account is safe to delete outright.
  const tsnap = await tref.get();
  const tdata = tsnap.exists ? (tsnap.data() || {}) : {};
  const ownerEmails = Array.isArray(tdata.ownerEmails) ? tdata.ownerEmails : [];

  // recursiveDelete handles arbitrary nesting and large subcollections
  // server-side; far more reliable than client-side per-doc loops.
  await db.recursiveDelete(tref);

  // Remove from public directory (non-blocking; tenant is already gone).
  try {
    await removeDirectoryEntry(slug);
  } catch (err) {
    console.error('public directory remove failed for tenant', slug, err);
  }

  // Delete the owner's Firebase Auth account(s). Best-effort: a failure here
  // must NOT undo the (already completed) tenant deletion, so each lookup is
  // wrapped individually. A superadmin login is never deleted, even if one
  // somehow appears as an owner.
  const authDeleted = [];
  const authFailed = [];
  for (const raw of ownerEmails) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email || SUPERADMIN_EMAILS.has(email)) continue;
    try {
      const user = await getAuth().getUserByEmail(email);
      await getAuth().deleteUser(user.uid);
      authDeleted.push(email);
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') continue; // already gone
      console.error('auth user delete failed for', email, err);
      authFailed.push(email);
    }
  }

  return { slug, deleted: true, authDeleted, authFailed };
});

// ============================================================
// rebuildPublicDirectory — superadmin-only. Rescans every tenant doc
// and rewrites public/directory from scratch. Used for one-time backfill
// after this feature shipped, and as a recovery tool if the doc drifts.
// ============================================================
exports.rebuildPublicDirectory = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const snap = await db.collection('tenants').get();
  const stores = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    stores.push({ slug: doc.id, name: data.name || doc.id });
  }
  // Sort alphabetically by name so the client can show a stable order.
  stores.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  await PUBLIC_DIRECTORY_REF().set({
    stores,
    updatedAt: FieldValue.serverTimestamp(),
    rebuiltAt: FieldValue.serverTimestamp(),
    rebuiltBy: token.email
  });
  return { count: stores.length, stores };
});

// ============================================================
// backfillSubscriptions — superadmin-only. Idempotent migration that
// ensures every tenant has BOTH a subscription/current doc AND a tier
// field on their settings/store doc.
//   - If no subscription doc exists, seeds PabiliMart Free Active.
//   - If subscription exists, mirrors its tier into settings/store so the
//     storefront's "Powered by Pabili Mart" footer gate is in sync.
// Safe to re-run.
// ============================================================
exports.backfillSubscriptions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const snap = await db.collection('tenants').get();
  let seeded = 0, skipped = 0, tierSynced = 0;
  for (const doc of snap.docs) {
    const subRef = doc.ref.collection('subscription').doc('current');
    const settingsRef = doc.ref.collection('settings').doc('store');
    const subSnap = await subRef.get();
    let tier = 'free';
    if (!subSnap.exists) {
      await subRef.set(getInitialSubscription({ tier: 'free' }));
      seeded++;
    } else {
      skipped++;
      tier = (subSnap.data() || {}).tier || 'free';
    }
    // Always sync tier mirror to settings/store (idempotent on merge).
    await settingsRef.set({ tier }, { merge: true });
    // Also mirror to tenant root doc so the superadmin tenants table can
    // render the Plan column from the paginated list without per-row reads.
    await doc.ref.set({ tier }, { merge: true });
    tierSynced++;
  }
  return { seeded, skipped, tierSynced, total: snap.size };
});

// ============================================================
// backfillOwnerClaims — superadmin one-shot. Sets the { tenants: [...] }
// custom auth claim on every existing tenant owner so the new claim-based
// Storage rules let them upload product images. Idempotent (only writes when
// the claim set changes). Owners must refresh their token afterward — the
// admin app force-refreshes automatically (handleAdminAuth).
// ============================================================
exports.backfillOwnerClaims = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const snap = await db.collection('tenants').get();
  // Build email -> set of owned tenant slugs.
  const emailToTids = {};
  snap.forEach(doc => {
    const d = doc.data() || {};
    (Array.isArray(d.ownerEmails) ? d.ownerEmails : []).forEach(e => {
      const k = String(e || '').toLowerCase().trim();
      if (!k) return;
      (emailToTids[k] = emailToTids[k] || new Set()).add(doc.id);
    });
  });

  let updated = 0, unchanged = 0, missingUser = 0, errored = 0;
  for (const [email, tidsSet] of Object.entries(emailToTids)) {
    try {
      const u = await getAuth().getUserByEmail(email);
      const claims = (u && u.customClaims) || {};
      const existing = Array.isArray(claims.tenants) ? claims.tenants : [];
      const merged = Array.from(new Set([...existing, ...tidsSet]));
      const changed = merged.length !== existing.length || merged.some(t => !existing.includes(t));
      if (changed) {
        await getAuth().setCustomUserClaims(u.uid, { ...claims, tenants: merged });
        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') missingUser++;
      else { errored++; console.warn('[backfillOwnerClaims]', email, ':', err && err.message); }
    }
  }
  return { tenants: snap.size, owners: Object.keys(emailToTids).length, updated, unchanged, missingUser, errored };
});

// ============================================================
// migrateProductImages — superadmin one-shot (batched). Moves a tenant's
// product images out of Firestore (base64 in `images[]`) into Cloud
// Storage, replacing each base64 entry with a Firebase download URL.
// Idempotent: https: entries are left alone, so it's safe to re-run.
// Drive it in batches until { done: true }.
// ============================================================
const PRODUCT_IMAGE_BUCKET = 'jt-sari-sari-store.firebasestorage.app';

exports.migrateProductImages = onCall({ memory: '512MiB', timeoutSeconds: 540 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  const limit = Math.min(Math.max(parseInt(data.limit, 10) || 75, 1), 300);
  const cursor = data.cursor ? String(data.cursor) : null;

  const bucket = getStorage().bucket(PRODUCT_IMAGE_BUCKET);
  const col = db.collection('tenants').doc(tid).collection('products');
  let q = col.orderBy(FieldPath.documentId()).limit(limit);
  if (cursor) q = col.orderBy(FieldPath.documentId()).startAfter(cursor).limit(limit);

  const snap = await q.get();
  let processed = 0, updated = 0, imagesUploaded = 0;
  let lastId = cursor;

  for (const doc of snap.docs) {
    processed++;
    lastId = doc.id;
    const images = Array.isArray((doc.data() || {}).images) ? doc.data().images : [];
    if (!images.length) continue;
    let changed = false;
    const out = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const m = (typeof img === 'string') && img.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        const dlToken = crypto.randomUUID();
        const path = `tenants/${tid}/products/${doc.id}/${i}.jpg`;
        await bucket.file(path).save(buf, {
          resumable: false,
          metadata: {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable',
            metadata: { firebaseStorageDownloadTokens: dlToken }
          }
        });
        out.push(`https://firebasestorage.googleapis.com/v0/b/${PRODUCT_IMAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${dlToken}`);
        imagesUploaded++;
        changed = true;
      } else if (typeof img === 'string' && img) {
        out.push(img); // already a URL — leave it
      }
    }
    if (changed) {
      await doc.ref.update({ images: out });
      updated++;
    }
  }

  return {
    processed,
    updated,
    imagesUploaded,
    nextCursor: lastId,
    done: snap.size < limit
  };
});

// ============================================================
// Build a <=6-char uppercased code from the slug's hyphen-separated words
// for the GCash payment reference. Each word gets a fair share toward 6
// chars; if a word is shorter than its share, the leftover carries to the
// next word. "jacob"->JACOB, "jacob-store"->JACSTO, "my-store"->MYSTOR,
// "js-mini-mart"->JSMIMA. MUST stay identical to slugRefCode() in admin.html.
function slugRefCode(slug) {
  const words = String(slug || '').split('-')
    .map(w => w.replace(/[^A-Za-z0-9]/g, '').toUpperCase())
    .filter(Boolean);
  let remaining = 6, code = '';
  for (let i = 0; i < words.length && remaining > 0; i++) {
    const take = Math.min(Math.ceil(remaining / (words.length - i)), words[i].length);
    code += words[i].slice(0, take);
    remaining -= take;
  }
  return code;
}

// submitManualPayment — tenant owner submits a manual GCash payment for
// a tier upgrade or renewal. Creates a pending_verification payment doc
// + fires a Discord webhook so the superadmin can confirm in real time.
//
// Validation: requested tier exists, amount matches tier price, receipt
// is a reasonable size (compressed client-side), tenant owns the tid.
//
// Idempotency: the reference code (PM + 6-char slug + YYYYMM) is the doc ID,
// so resubmitting the same month overwrites the previous pending doc
// for that period — prevents duplicate submissions clogging the queue.
// ============================================================
// ============================================================
// startFreeTrial — tenant admin callable. Moves a Free-tier tenant to a
// paid tier (Growth or Pro) in a `trialing` status for FREE_TRIAL_DAYS,
// without requiring a payment up front. Each tenant gets exactly ONE
// free trial across their entire lifetime, tracked by `trialUsedAt` on
// the subscription doc.
//
// Eligibility:
//   - Tenant is currently on the Free plan (subscription.tier === 'free')
//   - subscription.trialUsedAt is null (never trialed before)
//
// After the trial ends the existing pay flow is what they use to stay
// on the paid tier — confirmManualPayment transitions trialing → active
// in the same way it does for signup-direct-to-paid tenants.
// ============================================================
exports.startFreeTrial = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const requestedTier = String(data.tier || '').trim();

  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  if (!SUBSCRIPTION_TIERS[requestedTier] || requestedTier === 'free') {
    throw new HttpsError('invalid-argument', 'Choose a paid tier (Growth or Pro).');
  }

  // ---- Ownership check ----
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can start a trial.');
  }

  // ---- Eligibility + write in one transaction so a double-click can't
  //      double-start the trial. ----
  const subRef = tref.collection('subscription').doc('current');
  const settingsRef = tref.collection('settings').doc('store');
  const tierConfig = SUBSCRIPTION_TIERS[requestedTier];
  const now = new Date();
  const trialEnd = new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  await db.runTransaction(async (tx) => {
    const subSnap = await tx.get(subRef);
    const cur = subSnap.exists ? (subSnap.data() || {}) : {};
    if (cur.tier && cur.tier !== 'free') {
      throw new HttpsError('failed-precondition',
        `Your store is already on ${SUBSCRIPTION_TIERS[cur.tier]?.name || cur.tier}. Trials are only available from Free.`);
    }
    if (cur.trialUsedAt) {
      throw new HttpsError('failed-precondition',
        'You\'ve already used your free trial. Switch plans by paying for the new plan from Billing.');
    }
    tx.set(subRef, {
      tier: requestedTier,
      status: 'trialing',
      amount: tierConfig.amount,
      currentPeriodStart: FieldValue.serverTimestamp(),
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
      trialUsedAt: FieldValue.serverTimestamp(),
      pastDueSince: null,
      suspendedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      paymentMethod: 'manual_gcash'
    }, { merge: true });
    // Mirror tier to settings/store so storefront branding (Powered by
    // footer, product cap pill) flips immediately without waiting for
    // confirmManualPayment.
    tx.set(settingsRef, { tier: requestedTier }, { merge: true });
    // Tier mirror on the tenant root doc (superadmin tenants list).
    tx.update(tref, { tier: requestedTier });
  });

  // Starting a PRO trial injects the catalog-store catalog as a HIDDEN starter
  // catalog — same as a direct Pro signup / paid Pro upgrade. Trials have no
  // confirmation step, so this is the only automatic hook. Once-only per tenant
  // (flag-guarded in the helper); best-effort so it never fails the trial.
  if (requestedTier === 'pro') {
    try { await injectStarterCatalog(tid); }
    catch (err) { console.warn('[startFreeTrial] starter catalog inject failed for', tid, ':', err.message); }
  }

  return {
    ok: true,
    tier: requestedTier,
    tierName: tierConfig.name,
    trialEndsAt: trialEnd.toISOString()
  };
});

exports.submitManualPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const requestedTier = String(data.tier || '').trim();
  const receiptDataUrl = String(data.receiptDataUrl || '');
  const receiptName = String(data.receiptName || 'receipt.jpg').slice(0, 200);
  const senderNote = String(data.senderNote || '').slice(0, 300); // optional

  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  if (!SUBSCRIPTION_TIERS[requestedTier] || requestedTier === 'free') {
    throw new HttpsError('invalid-argument', 'Choose a paid tier (Growth or Pro).');
  }
  if (!receiptDataUrl.startsWith('data:image/')) {
    throw new HttpsError('invalid-argument', 'Receipt is missing or not an image.');
  }
  if (receiptDataUrl.length > 1_500_000) {
    throw new HttpsError('invalid-argument', 'Receipt image too large. Compress under 1.5 MB.');
  }

  // ---- Ownership check ----
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can submit a payment.');
  }

  // ---- Compute reference code (YYYYMM in Manila time) ----
  const manila = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const period = manila.getFullYear() + String(manila.getMonth() + 1).padStart(2, '0');
  // PM + <=6-char slug code + YYYYMM. Short & alphanumeric so the owner can
  // paste it into GCash's Message/Note (no special chars). slugRefCode()
  // MUST match the client's formula in admin.html.
  const referenceCode = `PM${slugRefCode(tid)}${period}`;

  // ---- Write payment doc (idempotent on referenceCode) ----
  const paymentRef = tref.collection('payments').doc(referenceCode);
  await paymentRef.set({
    amount: SUBSCRIPTION_TIERS[requestedTier].amount,
    tier: requestedTier,
    period,
    referenceCode,
    status: 'pending_verification',
    submittedAt: FieldValue.serverTimestamp(),
    submittedBy: email,
    senderNote: senderNote || null,
    receiptDataUrl, // base64; small enough at 900px JPEG q=0.7
    receiptName,
    confirmedAt: null,
    confirmedBy: null,
    rejectedAt: null,
    rejectedReason: null
  });

  // ---- Discord notification (best-effort, non-blocking) ----
  try {
    const billingSnap = await db.collection('platform').doc('billing').get();
    const webhook = billingSnap.exists ? (billingSnap.data() || {}).subscriptionDiscordWebhook : null;
    if (webhook) {
      const tierConfig = SUBSCRIPTION_TIERS[requestedTier];
      const lines = [
        `💰 **Subscription payment submitted**`,
        `Tenant: \`${tid}\` (${tenant.name || tid})`,
        `Tier: ${tierConfig.name} — ₱${tierConfig.amount}`,
        `Reference: \`${referenceCode}\``,
        `From: ${email}`,
        senderNote ? `Note: ${senderNote}` : null,
        ``,
        `→ Review in superadmin → Pending Payments`
      ].filter(Boolean).join('\n');
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: lines })
      });
    }
  } catch (err) {
    console.error('discord notification failed:', err);
  }

  return { referenceCode, status: 'pending_verification' };
});

// ============================================================
// listPendingPayments — superadmin-only. Returns all pending_verification
// payments across every tenant so the superadmin can review the queue.
// Bypasses firestore.rules `list` restriction by running with admin SDK.
// ============================================================
exports.listPendingPayments = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  // Collection group query across every tenants/*/payments/* doc.
  const snap = await db.collectionGroup('payments')
    .where('status', '==', 'pending_verification')
    .orderBy('submittedAt', 'asc')
    .limit(200)
    .get();

  // Hydrate each payment with its tenant's storefront name so the
  // superadmin can see which store it's from.
  const tenantNameCache = {};
  async function getTenantName(tid) {
    if (tid in tenantNameCache) return tenantNameCache[tid];
    const t = await db.collection('tenants').doc(tid).get();
    const name = t.exists ? (t.data().name || tid) : tid;
    tenantNameCache[tid] = name;
    return name;
  }

  const payments = [];
  for (const doc of snap.docs) {
    // Path: tenants/{tid}/payments/{pid}
    const parts = doc.ref.path.split('/');
    const tid = parts[1];
    const v = doc.data() || {};
    const tenantName = await getTenantName(tid);
    payments.push({
      tid,
      tenantName,
      paymentId: doc.id,
      referenceCode: v.referenceCode || doc.id,
      tier: v.tier,
      amount: v.amount,
      period: v.period,
      submittedAt: v.submittedAt ? v.submittedAt.toMillis() : null,
      submittedBy: v.submittedBy || null,
      senderNote: v.senderNote || null,
      receiptDataUrl: v.receiptDataUrl || null,
      receiptName: v.receiptName || null
    });
  }
  return { payments };
});

// ============================================================
// listPaymentsAll — superadmin-only. Returns recent payments across
// all tenants (or filtered to one tenant), sorted by submittedAt desc.
// Used by the Transaction history table in /superadmin/.
//
// Iterates each tenant's payments subcollection then merges — avoids
// the collectionGroup composite index dance for this single-field
// orderBy. Fine at pilot scale (3 tenants × ~30 payments each = 90
// reads). Revisit at 100+ paying tenants.
// ============================================================
exports.listPaymentsAll = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};
  const tidFilter = data.tid ? String(data.tid).trim() : null;
  const statusFilter = data.status ? String(data.status).trim() : null;
  const limit = Math.min(500, Math.max(1, parseInt(data.limit) || 200));

  // Build the tenant set to scan.
  let tenantDocs;
  if (tidFilter) {
    const single = await db.collection('tenants').doc(tidFilter).get();
    tenantDocs = single.exists ? [single] : [];
  } else {
    const all = await db.collection('tenants').get();
    tenantDocs = all.docs;
  }

  const allPayments = [];
  for (const tDoc of tenantDocs) {
    const tName = (tDoc.data() || {}).name || tDoc.id;
    let q = tDoc.ref.collection('payments').orderBy('submittedAt', 'desc');
    if (statusFilter) q = q.where('status', '==', statusFilter);
    const psnap = await q.limit(50).get();
    psnap.docs.forEach(d => {
      const v = d.data() || {};
      allPayments.push({
        tid: tDoc.id,
        tenantName: tName,
        paymentId: d.id,
        referenceCode: v.referenceCode || d.id,
        tier: v.tier,
        amount: v.amount,
        period: v.period,
        status: v.status,
        submittedAt: v.submittedAt ? v.submittedAt.toMillis() : null,
        submittedBy: v.submittedBy || null,
        confirmedAt: v.confirmedAt ? v.confirmedAt.toMillis() : null,
        confirmedBy: v.confirmedBy || null,
        rejectedAt: v.rejectedAt ? v.rejectedAt.toMillis() : null,
        rejectedReason: v.rejectedReason || null,
        receiptDataUrl: v.receiptDataUrl || null,
        receiptName: v.receiptName || null,
        senderNote: v.senderNote || null
      });
    });
  }
  allPayments.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return { payments: allPayments.slice(0, limit), total: allPayments.length };
});

// ============================================================
// confirmManualPayment — superadmin-only. Marks a payment confirmed +
// extends the tenant's subscription by 30 days, switches tier if needed,
// clears any past_due / grace / suspended state.
// ============================================================
exports.confirmManualPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const paymentId = String(data.paymentId || '').trim();
  if (!tid || !paymentId) throw new HttpsError('invalid-argument', 'tid and paymentId are required');

  const tref = db.collection('tenants').doc(tid);
  const pref = tref.collection('payments').doc(paymentId);
  const sref = tref.collection('subscription').doc('current');

  let confirmedTier = null;
  await db.runTransaction(async (tx) => {
    const psnap = await tx.get(pref);
    if (!psnap.exists) throw new HttpsError('not-found', 'Payment not found.');
    const p = psnap.data() || {};
    if (p.status !== 'pending_verification') {
      throw new HttpsError('failed-precondition', `Payment is not pending (status: ${p.status}).`);
    }
    const tier = p.tier;
    confirmedTier = tier;
    if (!SUBSCRIPTION_TIERS[tier] || tier === 'free') {
      throw new HttpsError('failed-precondition', 'Payment is for an unknown or non-paid tier.');
    }

    // Extend subscription. currentPeriodEnd = max(today, current end) + 30 days
    // so paying early doesn't lose time, paying late doesn't double up.
    const now = new Date();
    const ssnap = await tx.get(sref);
    const sub = ssnap.exists ? ssnap.data() : null;
    let baseDate = now;
    if (sub && sub.currentPeriodEnd) {
      const currentEnd = sub.currentPeriodEnd.toDate
        ? sub.currentPeriodEnd.toDate()
        : new Date(sub.currentPeriodEnd);
      if (currentEnd.getTime() > now.getTime()) baseDate = currentEnd;
    }
    const newEnd = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Paying directly (without taking the free trial first) consumes the
    // trial entitlement — we only ever grant one trial per tenant.
    // trialUsedAt is preserved if already set (e.g. they're paying after
    // their trial), otherwise set now.
    const trialUsedAt = (sub && sub.trialUsedAt) ? sub.trialUsedAt : FieldValue.serverTimestamp();
    tx.set(sref, {
      tier,
      status: 'active',
      amount: SUBSCRIPTION_TIERS[tier].amount,
      currentPeriodStart: ssnap.exists && sub.currentPeriodEnd ? sub.currentPeriodEnd : FieldValue.serverTimestamp(),
      currentPeriodEnd: newEnd,
      trialEndsAt: null,
      trialUsedAt,
      pastDueSince: null,
      // Lifecycle automation: clear ALL grace/downgrade markers when a
      // payment confirms — a single payment resurrects a tenant from
      // grace/scheduled-downgrade back to active on the paid tier.
      graceSince: null,
      graceEndsAt: null,
      graceFromTier: null,
      graceToTier: null,
      scheduledTier: null,
      pendingRetainIds: null,
      dunningStages: [], // payment confirmed → reset the reminder cycle
      suspendedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      cancelAtPeriodEnd: false,
      cancellationRequestedAt: null,
      paymentMethod: 'manual_gcash',
      lastConfirmedPaymentRef: pref.path,
      lastConfirmedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.update(pref, {
      status: 'confirmed',
      confirmedAt: FieldValue.serverTimestamp(),
      confirmedBy: token.email,
      newPeriodEnd: newEnd
    });

    // Mirror tier into settings/store so the customer-facing storefront
    // can gate the "Powered by Pabili Mart" footer without needing
    // subscription doc read access. Public-read on settings/* already.
    const settingsRef = tref.collection('settings').doc('store');
    tx.set(settingsRef, { tier }, { merge: true });
    // Tier mirror on the tenant root doc (superadmin tenants list).
    tx.update(tref, { tier });
  });

  // After confirming, re-cap the catalog to the paid tier: upgrading to Pro
  // un-archives everything (cap 6000 ≥ catalog); renewing Growth keeps the
  // current visible 500. Best-effort — the payment is already committed.
  if (confirmedTier && confirmedTier !== 'free') {
    try { await archiveProductsForTier(tid, confirmedTier, []); }
    catch (err) { console.warn('[confirmManualPayment] re-cap failed for', tid, ':', err.message); }
  }

  // Reaching Pro (from Growth/Free/trial) injects the JS Mini Mart catalog as a
  // HIDDEN starter catalog — once per tenant (flag-guarded in the helper).
  if (confirmedTier === 'pro') {
    try { await injectStarterCatalog(tid); }
    catch (err) { console.warn('[confirmManualPayment] starter catalog inject failed for', tid, ':', err.message); }
  }

  return { paymentId, tid, status: 'confirmed' };
});

// ============================================================
// injectStarterCatalogFor — superadmin manual trigger for the Pro starter
// catalog (testing / one-off backfill). `force: true` first deletes any prior
// starter-catalog products + clears the flag for a clean re-run.
// ============================================================
exports.injectStarterCatalogFor = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};

  // One-time master setup: seed catalog-store from jsminimart + make it Pro.
  // (Folded into this already-invoker-granted callable to avoid a new grant.)
  if (String(data.action || '') === 'seed-catalog-store') {
    return await seedCatalogStore({ force: data.force === true });
  }
  // Pin any tenant to forever Pro (e.g. jsminimart — Jason's own store).
  if (String(data.action || '') === 'forever-pro') {
    const ftid = String(data.tid || '').trim().toLowerCase();
    if (!ftid) throw new HttpsError('invalid-argument', 'tid is required');
    return await setTenantForeverPro(ftid);
  }

  const tid = String(data.tid || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');

  if (data.force === true) {
    // Clean re-run: drop existing starter-catalog products + the once-only flag.
    const tref = db.collection('tenants').doc(tid);
    const prev = await tref.collection('products').where('fromStarterCatalog', '==', true).get();
    let b = db.batch(), n = 0, removed = 0;
    for (const d of prev.docs) {
      b.delete(d.ref); removed++;
      if (++n >= 400) { await b.commit(); b = db.batch(); n = 0; }
    }
    if (n > 0) await b.commit();
    await tref.update({
      starterCatalogInjected: FieldValue.delete(),
      starterCatalogInjectedAt: FieldValue.delete(),
      starterCatalogCount: FieldValue.delete()
    }).catch(() => {});
    const r = await injectStarterCatalog(tid);
    return { tid, forced: true, removed, ...r };
  }

  const r = await injectStarterCatalog(tid);
  return { tid, ...r };
});

// ============================================================
// STAFF ACCOUNTS & ROLES (Pro feature) — Phase 0 backend plumbing.
// Per-person employee logins + a permission matrix so the owner can see/limit
// what each employee does. Membership lives at tenants/{tid}/members/{uid};
// pending invites at tenants/{tid}/staff_invites/{emailKey}. Writes go ONLY
// through these callables (Admin SDK) — clients can never self-grant. Plan:
// Obsidian "Staff Accounts & Roles - Plan.md".
//
// NOTE: stockincrease is OWNER-ONLY and intentionally NOT a grantable key —
// it's the anti-fraud lever (prevents "sell an item, re-add the stock").
// ============================================================
const STAFF_PERMISSION_KEYS = new Set([
  // financials (hidden by default for staff)
  'totalprofitview', 'totalrevenueview', 'profitmarginview', 'totalcostview', 'deliverycollectedview',
  // orders
  'orderstabview', 'orderconfirm', 'ordercancel', 'ordercopy', 'orderrefund', 'customerinfoview',
  // products (stockincrease NOT here — owner-only)
  'productstabview', 'productadd', 'productedit', 'productdelete', 'stockdecrease', 'availabilitytoggle', 'visibilitytoggle',
  // suppliers
  'supplierstabview', 'supplieradd', 'supplieredit', 'supplierdelete',
  // reports
  'reportstabview', 'reportdownload', 'reportprint',
  // billing
  'billingtabview', 'billingcontactsupport', 'billingavailableplan', 'billingpaymenthistoryview',
  // store ops
  'settingstabview', 'settingsedit', 'modestoggle', 'branchmanage'
]);

// Granting an action implies its tab-view (no impossible "can confirm but can't see Orders" states).
const STAFF_PERMISSION_DEPS = {
  orderconfirm: 'orderstabview', ordercancel: 'orderstabview', ordercopy: 'orderstabview',
  orderrefund: 'orderstabview', customerinfoview: 'orderstabview',
  productadd: 'productstabview', productedit: 'productstabview', productdelete: 'productstabview',
  stockdecrease: 'productstabview', availabilitytoggle: 'productstabview', visibilitytoggle: 'productstabview',
  supplieradd: 'supplierstabview', supplieredit: 'supplierstabview', supplierdelete: 'supplierstabview',
  reportdownload: 'reportstabview', reportprint: 'reportstabview',
  billingcontactsupport: 'billingtabview', billingavailableplan: 'billingtabview', billingpaymenthistoryview: 'billingtabview',
  settingsedit: 'settingstabview'
};

const STAFF_ROLE_PRESETS = {
  cashier:    ['orderstabview', 'orderconfirm', 'ordercancel', 'ordercopy', 'productstabview', 'availabilitytoggle', 'stockdecrease'],
  stockclerk: ['productstabview', 'stockdecrease', 'availabilitytoggle', 'supplierstabview'],
  manager:    ['orderstabview', 'orderconfirm', 'ordercancel', 'ordercopy', 'customerinfoview',
               'productstabview', 'productadd', 'productedit', 'stockdecrease', 'availabilitytoggle', 'visibilitytoggle',
               'supplierstabview', 'supplieradd', 'supplieredit', 'reportstabview', 'modestoggle']
};

const STAFF_CAP = 10; // max staff (members + pending invites) per tenant

// Keep only valid `true` keys, then auto-add implied tab-views.
function sanitizeStaffPermissions(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const k of Object.keys(input)) {
      if (STAFF_PERMISSION_KEYS.has(k) && input[k] === true) out[k] = true;
    }
  }
  for (const [action, view] of Object.entries(STAFF_PERMISSION_DEPS)) {
    if (out[action]) out[view] = true;
  }
  return out;
}

function presetPermissions(preset) {
  const keys = STAFF_ROLE_PRESETS[preset];
  if (!Array.isArray(keys)) return null;
  const obj = {}; keys.forEach(k => { obj[k] = true; });
  return sanitizeStaffPermissions(obj);
}

function staffEmailKey(email) {
  return Buffer.from(String(email || '').trim().toLowerCase()).toString('hex');
}

// Owner-of-Pro gate for staff-management callables. Superadmin bypasses tier.
async function requireStaffManager(tid, token) {
  if (!token || token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Email must be verified.');
  }
  const email = String(token.email || '').trim().toLowerCase();
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Store not found.');
  const tenant = tsnap.data() || {};
  const isSuper = SUPERADMIN_EMAILS.has(email);
  const ownerEmails = (Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : []).map(e => String(e).toLowerCase());
  if (!isSuper && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only the store owner can manage staff.');
  }
  if (!isSuper) {
    const sub = (await tref.collection('subscription').doc('current').get()).data() || {};
    if (String(sub.tier || 'free').toLowerCase() !== 'pro') {
      throw new HttpsError('failed-precondition', 'Staff accounts are a Pro feature. Upgrade to Pro to add employees.');
    }
  }
  return { tref, tenant, email, isSuper, ownerEmails };
}

async function grantTenantClaim(uid, slug) {
  const u = await getAuth().getUser(uid);
  const claims = (u && u.customClaims) || {};
  const owned = Array.isArray(claims.tenants) ? claims.tenants : [];
  if (!owned.includes(slug)) await getAuth().setCustomUserClaims(uid, { ...claims, tenants: [...owned, slug] });
}
async function revokeTenantClaim(uid, slug) {
  const u = await getAuth().getUser(uid);
  const claims = (u && u.customClaims) || {};
  const owned = Array.isArray(claims.tenants) ? claims.tenants : [];
  if (owned.includes(slug)) await getAuth().setCustomUserClaims(uid, { ...claims, tenants: owned.filter(t => t !== slug) });
}

// ---- addStaffMember — owner invites an employee by email ----
exports.addStaffMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  const email = String(data.email || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  const { tref, ownerEmails } = await requireStaffManager(tid, request.auth.token);
  if (ownerEmails.includes(email)) {
    throw new HttpsError('failed-precondition', 'That email is already an owner of this store.');
  }

  // Permissions: explicit map OR a named preset.
  const preset = STAFF_ROLE_PRESETS[String(data.preset || '')] ? String(data.preset) : null;
  const permissions = preset ? presetPermissions(preset) : sanitizeStaffPermissions(data.permissions);

  // Cap check (active members + pending invites).
  const [membersSnap, invitesSnap] = await Promise.all([
    tref.collection('members').get(),
    tref.collection('staff_invites').get()
  ]);
  const alreadyMember = membersSnap.docs.some(d => String((d.data() || {}).email || '').toLowerCase() === email);
  if (alreadyMember) throw new HttpsError('already-exists', 'That employee is already added.');
  if (membersSnap.size + invitesSnap.size >= STAFF_CAP) {
    throw new HttpsError('resource-exhausted', `You can have up to ${STAFF_CAP} employees.`);
  }

  const name = String(data.name || '').trim().slice(0, 80) || null;
  await tref.collection('staff_invites').doc(staffEmailKey(email)).set({
    tid, email, name, role: 'staff', preset, permissions, status: 'invited',
    invitedBy: request.auth.token.email, invitedAt: FieldValue.serverTimestamp()
  });
  // Reverse lookup (server-only) so this employee can sign in via the
  // pabilimart.com front door — getMyTenant resolves their stores by email
  // hash without a collection-group query. Keyed by the same email hash.
  try {
    await db.collection('staff_invite_lookup').doc(staffEmailKey(email)).set(
      { email, tenants: { [tid]: true } }, { merge: true }
    );
  } catch (err) { console.warn('[addStaffMember] lookup write failed:', err.message); }
  return { ok: true, email, status: 'invited' };
});

// ---- acceptStaffInvite — employee accepts on first admin login (self) ----
exports.acceptStaffInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const tid = String((request.data || {}).tid || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required.');
  const email = String(token.email || '').trim().toLowerCase();
  const uid = request.auth.uid;
  const tref = db.collection('tenants').doc(tid);

  // Already an active member? Idempotent success.
  const mref = tref.collection('members').doc(uid);
  const msnap = await mref.get();
  if (msnap.exists && (msnap.data() || {}).status === 'active') {
    return { ok: true, status: 'active', permissions: (msnap.data() || {}).permissions || {} };
  }

  const inviteRef = tref.collection('staff_invites').doc(staffEmailKey(email));
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) throw new HttpsError('not-found', 'No staff invite for this account.');
  const invite = inviteSnap.data() || {};

  await mref.set({
    email, role: 'staff', name: invite.name || (token && token.name) || null,
    permissions: invite.permissions || {}, preset: invite.preset || null,
    status: 'active', addedBy: invite.invitedBy || null,
    addedAt: FieldValue.serverTimestamp(), acceptedAt: FieldValue.serverTimestamp()
  });
  await inviteRef.delete();
  try { await grantTenantClaim(uid, tid); } catch (err) { console.warn('[acceptStaffInvite] claim grant failed:', err.message); }
  return { ok: true, status: 'active', permissions: invite.permissions || {} };
});

// ---- updateStaffPermissions — owner edits an employee's permissions ----
exports.updateStaffPermissions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  const memberUid = String(data.uid || '').trim();
  const inviteEmail = String(data.email || '').trim().toLowerCase();
  if (!tid || (!memberUid && !inviteEmail)) throw new HttpsError('invalid-argument', 'tid and uid (or email) required.');
  const { tref } = await requireStaffManager(tid, request.auth.token);

  const preset = STAFF_ROLE_PRESETS[String(data.preset || '')] ? String(data.preset) : null;
  const permissions = preset ? presetPermissions(preset) : sanitizeStaffPermissions(data.permissions);
  const patch = { permissions, preset, updatedAt: FieldValue.serverTimestamp() };
  if (typeof data.name === 'string') patch.name = data.name.trim().slice(0, 80) || null;

  if (memberUid) {
    const mref = tref.collection('members').doc(memberUid);
    if (!(await mref.get()).exists) throw new HttpsError('not-found', 'Employee not found.');
    // update() (NOT set-merge) so the permissions map is REPLACED wholesale —
    // set+merge deep-merges maps, which would never remove a turned-off perm.
    await mref.update(patch);
  } else {
    const iref = tref.collection('staff_invites').doc(staffEmailKey(inviteEmail));
    if (!(await iref.get()).exists) throw new HttpsError('not-found', 'Invite not found.');
    await iref.update(patch);
  }
  return { ok: true, permissions };
});

// ---- removeStaffMember — owner removes an employee or cancels an invite ----
exports.removeStaffMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  const memberUid = String(data.uid || '').trim();
  const inviteEmail = String(data.email || '').trim().toLowerCase();
  if (!tid || (!memberUid && !inviteEmail)) throw new HttpsError('invalid-argument', 'tid and uid (or email) required.');
  const { tref } = await requireStaffManager(tid, request.auth.token);

  let removed = null;
  let cleanupEmail = inviteEmail || null;
  if (memberUid) {
    const mref = tref.collection('members').doc(memberUid);
    const mdata = (await mref.get()).data() || {};
    if (!cleanupEmail) cleanupEmail = String(mdata.email || '').toLowerCase() || null;
    await mref.delete();
    try { await revokeTenantClaim(memberUid, tid); } catch (err) { console.warn('[removeStaffMember] claim revoke failed:', err.message); }
    // Credential (no-email) logins are tenant-owned synthetic accounts — delete
    // the Auth user so the username frees up and no orphan login is left behind.
    if (mdata.loginType === 'credential') {
      try { await getAuth().deleteUser(memberUid); } catch (err) { console.warn('[removeStaffMember] auth delete failed:', err.message); }
    }
    removed = 'member';
  }
  if (inviteEmail) {
    await tref.collection('staff_invites').doc(staffEmailKey(inviteEmail)).delete();
    removed = removed || 'invite';
  }
  // Drop this tenant from the employee's front-door reverse lookup (best-effort).
  if (cleanupEmail) {
    try {
      await db.collection('staff_invite_lookup').doc(staffEmailKey(cleanupEmail))
        .update(new FieldPath('tenants', tid), FieldValue.delete());
    } catch (err) { /* doc/key may not exist — fine */ }
  }
  return { ok: true, removed };
});

// ---- leaveStore — an employee removes THEMSELVES from a store ----
// For when someone resigned but the owner never removed them: self-service so
// their email is freed to create their own store (otherwise the pabilimart.com
// front door keeps routing them into that store). Owners can't "leave" — they'd
// delete the store instead. Logged so the owner sees it in History.
exports.leaveStore = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const tid = String((request.data || {}).tid || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required.');
  const uid = request.auth.uid;
  const email = String(token.email || '').trim().toLowerCase();

  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Store not found.');
  const ownerEmails = Array.isArray((tsnap.data() || {}).ownerEmails) ? tsnap.data().ownerEmails : [];
  if (ownerEmails.includes(email)) {
    throw new HttpsError('failed-precondition', "You own this store, so you can't leave it.");
  }

  // Remove membership + any pending invite + claim + front-door lookup.
  await tref.collection('members').doc(uid).delete().catch(() => {});
  await tref.collection('staff_invites').doc(staffEmailKey(email)).delete().catch(() => {});
  try { await revokeTenantClaim(uid, tid); } catch (err) { console.warn('[leaveStore] claim revoke failed:', err.message); }
  try {
    await db.collection('staff_invite_lookup').doc(staffEmailKey(email))
      .update(new FieldPath('tenants', tid), FieldValue.delete());
  } catch (err) { /* doc/key may not exist — fine */ }

  try {
    await logActivity(tid, `staff-left-${uid}`, {
      type: 'staff.left', category: 'store', targetId: uid,
      summary: `${email} left the store`,
      actor: { uid, email, role: 'staff' }, source: 'self'
    });
  } catch (err) { /* non-fatal */ }

  return { ok: true };
});

// ---- createStaffCredential — owner provisions a USERNAME + PASSWORD login for
// an employee with NO email of their own. The Auth user is created server-side
// already-verified (no email is ever sent); the username is just a login id on
// a subdomain we control. Member is active immediately, with mustChangePassword
// so the employee sets their own password on first login. ----
const STAFF_CRED_DOMAIN = 'staff.pabilimart.com';
function staffCredentialEmail(tid, username) {
  return `${username}@${tid}.${STAFF_CRED_DOMAIN}`;
}

exports.createStaffCredential = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required.');
  const { tref } = await requireStaffManager(tid, request.auth.token);

  const name = String(data.name || '').trim().slice(0, 80);
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(username)) {
    throw new HttpsError('invalid-argument', 'Username must be 2–30 characters: lowercase letters, numbers, and . _ - (start with a letter or number).');
  }
  if (password.length < 6) throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');

  const preset = STAFF_ROLE_PRESETS[String(data.preset || '')] ? String(data.preset) : null;
  const permissions = preset ? presetPermissions(preset) : sanitizeStaffPermissions(data.permissions);

  const [membersSnap, invitesSnap] = await Promise.all([
    tref.collection('members').get(),
    tref.collection('staff_invites').get()
  ]);
  if (membersSnap.size + invitesSnap.size >= STAFF_CAP) {
    throw new HttpsError('resource-exhausted', `You can have up to ${STAFF_CAP} employees.`);
  }

  const email = staffCredentialEmail(tid, username);
  let existing = null;
  try { existing = await getAuth().getUserByEmail(email); }
  catch (err) { if (err.code !== 'auth/user-not-found') throw new HttpsError('internal', err.message || 'Lookup failed.'); }
  if (existing) throw new HttpsError('already-exists', 'That username is already taken in this store. Pick another.');

  const userRecord = await getAuth().createUser({ email, password, emailVerified: true, displayName: name || username });
  const uid = userRecord.uid;

  await tref.collection('members').doc(uid).set({
    email, username, name: name || username, role: 'staff',
    permissions, status: 'active',
    loginType: 'credential', mustChangePassword: true,
    invitedBy: request.auth.token.email,
    createdAt: FieldValue.serverTimestamp()
  });
  await grantTenantClaim(uid, tid);
  try {
    await db.collection('staff_invite_lookup').doc(staffEmailKey(email)).set(
      { email, tenants: { [tid]: true } }, { merge: true }
    );
  } catch (e) { console.warn('[createStaffCredential] lookup write failed:', e.message); }

  return { ok: true, uid, username, email };
});

// ---- setStaffPassword — a credential staff member sets their OWN password
// (first-login forced change). Self only; updates the Auth password and clears
// the mustChangePassword flag (members can't write their own doc via rules). ----
exports.setStaffPassword = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const data = request.data || {};
  const tid = String(data.tid || '').trim().toLowerCase();
  const newPassword = String(data.newPassword || '');
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required.');
  if (newPassword.length < 6) throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  const uid = request.auth.uid;
  const mref = db.collection('tenants').doc(tid).collection('members').doc(uid);
  if (!(await mref.get()).exists) throw new HttpsError('permission-denied', 'Not a member of this store.');
  await getAuth().updateUser(uid, { password: newPassword });
  await mref.update({ mustChangePassword: false, passwordChangedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ============================================================
// rejectManualPayment — superadmin-only. Marks a payment rejected with
// a reason. Does NOT modify the subscription doc.
// ============================================================
exports.rejectManualPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const paymentId = String(data.paymentId || '').trim();
  const reason = String(data.reason || '').trim().slice(0, 500);
  if (!tid || !paymentId) throw new HttpsError('invalid-argument', 'tid and paymentId are required');
  if (!reason) throw new HttpsError('invalid-argument', 'Please provide a reason for rejection.');

  const pref = db.collection('tenants').doc(tid).collection('payments').doc(paymentId);
  const psnap = await pref.get();
  if (!psnap.exists) throw new HttpsError('not-found', 'Payment not found.');
  const p = psnap.data() || {};
  if (p.status !== 'pending_verification') {
    throw new HttpsError('failed-precondition', `Payment is not pending (status: ${p.status}).`);
  }

  await pref.update({
    status: 'rejected',
    rejectedAt: FieldValue.serverTimestamp(),
    rejectedBy: token.email,
    rejectedReason: reason
  });

  return { paymentId, tid, status: 'rejected' };
});

// ============================================================
// getMyTenant — returns the list of tenants this signed-in account owns.
// Used by the signup page to swap the create-store form for a "you already
// have a store" landing card when the per-email cap is hit. Bypasses the
// firestore.rules `list` restriction (which only allows superadmin) by
// running with admin privileges server-side.
// ============================================================
// ============================================================
// generateInviteCode — superadmin mints a single-use signup code.
// Optionally binds the code to a specific email (only that email can
// redeem it) and attaches a free-text note for tracking.
// ============================================================
exports.generateInviteCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const data = request.data || {};
  const boundEmail = String(data.email || '').trim().toLowerCase();
  const note = String(data.note || '').trim().slice(0, 200);

  // Generate-and-retry on the extremely unlikely chance we collide.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomInviteCode();
    const ref = db.collection('invite_codes').doc(code);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({
      code,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: token.email,
      email: boundEmail || null,
      note: note || null,
      revoked: false,
      redeemedAt: null,
      redeemedBy: null,
      redeemedSlug: null
    });
    return {
      code,
      email: boundEmail || null,
      note: note || null,
      shareUrl: `https://pabilimart.com/signup/?code=${code}`
    };
  }
  throw new HttpsError('internal', 'Could not allocate a unique code. Try again.');
});

// ============================================================
// listInviteCodes — superadmin lists all minted codes with status.
// ============================================================
exports.listInviteCodes = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const snap = await db.collection('invite_codes')
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();
  return {
    codes: snap.docs.map(d => {
      const v = d.data() || {};
      return {
        code: d.id,
        email: v.email || null,
        note: v.note || null,
        revoked: v.revoked === true,
        createdAt: v.createdAt ? v.createdAt.toMillis() : null,
        createdBy: v.createdBy || null,
        redeemedAt: v.redeemedAt ? v.redeemedAt.toMillis() : null,
        redeemedBy: v.redeemedBy || null,
        redeemedSlug: v.redeemedSlug || null
      };
    })
  };
});

// ============================================================
// revokeInviteCode — superadmin invalidates a pending code so it can no
// longer be redeemed. Already-redeemed codes return an error since
// revoking them would do nothing meaningful (tenant already exists).
// ============================================================
exports.revokeInviteCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const code = normalizeInviteCode((request.data || {}).code);
  if (!code) throw new HttpsError('invalid-argument', 'code is required');
  const ref = db.collection('invite_codes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Code not found.');
  const v = snap.data() || {};
  if (v.redeemedAt) throw new HttpsError('failed-precondition', 'Code is already redeemed; cannot revoke.');
  await ref.update({ revoked: true, revokedAt: FieldValue.serverTimestamp(), revokedBy: token.email });
  return { code, revoked: true };
});

exports.getMyTenant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  const token = request.auth.token || {};
  if (token.email_verified !== true) {
    return { tenants: [], isSuperadmin: false, cap: MAX_TENANTS_PER_EMAIL };
  }
  const email = token.email;
  if (!email) return { tenants: [], isSuperadmin: false, cap: MAX_TENANTS_PER_EMAIL };

  const isSuperadmin = SUPERADMIN_EMAILS.has(email);
  const snap = await db.collection('tenants')
    .where('createdByEmail', '==', email)
    .limit(10)
    .get();

  const ownedSlugs = new Set(snap.docs.map(d => d.id));
  const tenants = snap.docs.map(d => {
    const data = d.data() || {};
    return {
      slug: d.id,
      name: data.name || d.id,
      url: `https://pabilimart.com/${d.id}/`,
      adminUrl: `https://pabilimart.com/${d.id}/admin/`
    };
  });

  // Staff memberships — so an employee can use the SAME front door as owners.
  // Two complementary sources, so no backfill is needed:
  //   (a) staff_invite_lookup mirror (email-hash → tenants) — covers pending
  //       invites (the employee's very first sign-in) + anyone added after this
  //       feature shipped; kept in sync by addStaffMember/removeStaffMember.
  //   (b) the {tenants:[...]} custom claim — covers active members added BEFORE
  //       the mirror existed (the claim is granted on accept, revoked on remove).
  // A stale entry is harmless: clicking through to /admin/ re-checks membership
  // and bounces a non-member, so this only ever offers a (possibly dead) link.
  let staffTenants = [];
  try {
    const staffTids = new Set();
    const lref = await db.collection('staff_invite_lookup').doc(staffEmailKey(email)).get();
    const map = (lref.exists && (lref.data() || {}).tenants) || {};
    Object.keys(map).forEach(tid => { if (tid && !ownedSlugs.has(tid)) staffTids.add(tid); });
    const claimTenants = Array.isArray(token.tenants) ? token.tenants : [];
    claimTenants.forEach(tid => { if (tid && !ownedSlugs.has(tid)) staffTids.add(tid); });
    if (staffTids.size > 0) {
      const tids = [...staffTids];
      const docs = await Promise.all(tids.map(tid => db.collection('tenants').doc(tid).get()));
      staffTenants = docs.filter(d => d.exists).map(d => {
        const data = d.data() || {};
        return {
          slug: d.id,
          name: data.name || d.id,
          url: `https://pabilimart.com/${d.id}/`,
          adminUrl: `https://pabilimart.com/${d.id}/admin/`,
          role: 'staff'
        };
      });
    }
  } catch (err) {
    console.warn('[getMyTenant] staff lookup failed:', err.message);
  }

  return {
    email,
    isSuperadmin,
    cap: isSuperadmin ? null : MAX_TENANTS_PER_EMAIL,
    tenants,
    staffTenants
  };
});

// ============================================================
// submitSupportTicket — Pro-only callable. Tenant owner submits a
// support ticket; backend validates Pro tier + non-suspended status,
// writes an audit record, and notifies the Pabili Mart support team
// via Discord webhook with an `<@&ROLE_ID>` mention so the on-call
// rotation gets pinged in real time.
//
// Webhook source: `platform/billing.prioritySupportWebhook` if set,
// otherwise falls back to `subscriptionDiscordWebhook` (the same one
// used for payment notifications). The role-mention placeholder is
// `PRIORITY_SUPPORT_ROLE_ID` below — set this to the Discord role ID
// before going live (see Discord setup docs).
// ============================================================
const PRIORITY_SUPPORT_ROLE_ID = '1513702654042308608'; // TODO: replace with real Discord role ID
const SUPPORT_SUBJECTS = new Set(['general', 'billing', 'bug', 'feature', 'how-to']);

exports.submitSupportTicket = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const subject = String(data.subject || '').trim().toLowerCase();
  const message = String(data.message || '').trim();

  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  if (!SUPPORT_SUBJECTS.has(subject)) {
    throw new HttpsError('invalid-argument', 'Invalid subject. Pick one of: general, billing, bug, feature, how-to.');
  }
  if (message.length < 20) {
    throw new HttpsError('invalid-argument', 'Please describe your issue in at least 20 characters so we can help quickly.');
  }
  if (message.length > 2000) {
    throw new HttpsError('invalid-argument', 'Message is too long. Trim to 2000 characters and try again.');
  }

  // Optional error screenshot — compressed client-side to a small JPEG data
  // URL. Kept well under Firestore's 1 MB doc limit.
  const screenshotDataUrl = String(data.screenshotDataUrl || '');
  const screenshotName = String(data.screenshotName || 'screenshot.jpg').slice(0, 200);
  const hasScreenshot = screenshotDataUrl.startsWith('data:image/');
  if (screenshotDataUrl && !hasScreenshot) {
    throw new HttpsError('invalid-argument', 'Screenshot must be an image.');
  }
  if (hasScreenshot && screenshotDataUrl.length > 900_000) {
    throw new HttpsError('invalid-argument', 'Screenshot is too large — it should compress under ~650 KB. Try a smaller crop.');
  }

  // Ownership + tier check.
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can submit a support ticket.');
  }

  const subSnap = await tref.collection('subscription').doc('current').get();
  const sub = subSnap.exists ? (subSnap.data() || {}) : {};
  const tier = (sub.tier || 'free').toLowerCase();
  const status = (sub.status || 'active').toLowerCase();
  // Support tickets: Growth + Pro (and superadmin). Pro = priority queue
  // (SLA + role ping); Growth = general queue (separate channel, no SLA).
  const isPriority = tier === 'pro' || isSuperadmin;
  if (tier !== 'pro' && tier !== 'growth' && !isSuperadmin) {
    throw new HttpsError('failed-precondition', 'Contacting support is available on Growth and Pro. Upgrade your plan to submit a ticket.');
  }
  if (['suspended', 'cancelled'].includes(status) && !isSuperadmin) {
    throw new HttpsError('failed-precondition', `Your subscription is ${status}. Reactivate it from the Billing tab to contact support.`);
  }

  // Generate a human-readable ticket ID. Used as the Firestore doc ID
  // (idempotent on retry within the same minute) and shown back to the
  // tenant for reference.
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ticketId = `SUP-${tid}-${stamp}`;
  const ticketRef = tref.collection('support_tickets').doc(ticketId);

  // Write the audit record first so we have a record even if Discord
  // delivery fails. setIfMissing-style behavior via create() means a
  // double-submit within the same second returns ALREADY_EXISTS cleanly.
  try {
    await ticketRef.create({
      ticketId,
      tid,
      tenantName: tenant.name || tid,
      tier,
      queue: isPriority ? 'priority' : 'general',
      status: 'open',
      subject,
      message,
      submittedBy: email,
      screenshot: hasScreenshot ? screenshotDataUrl : null,
      screenshotName: hasScreenshot ? screenshotName : null,
      submittedAt: FieldValue.serverTimestamp()
    });
  } catch (err) {
    if (err && err.code === 6 /* ALREADY_EXISTS */) {
      // Same-second double-submit — treat as a no-op success.
      return { ticketId, deduplicated: true };
    }
    throw err;
  }

  // Discord delivery. Pro tickets go to the priority channel; Growth
  // tickets go to a separate general-support channel. Both fall back to
  // the subscription/payment webhook if their dedicated one is unset.
  let webhook = null;
  try {
    const billingSnap = await db.collection('platform').doc('billing').get();
    const billing = billingSnap.exists ? (billingSnap.data() || {}) : {};
    webhook = isPriority
      ? (billing.prioritySupportWebhook || billing.subscriptionDiscordWebhook || null)
      : (billing.generalSupportWebhook || billing.subscriptionDiscordWebhook || null);
  } catch (err) {
    console.warn('[submitSupportTicket] platform/billing read failed:', err.message);
  }

  if (webhook) {
    const subjectLabel = {
      general: 'General question',
      billing: 'Billing',
      bug: 'Bug report',
      feature: 'Feature request',
      'how-to': 'How-to'
    }[subject] || subject;

    const content = [
      isPriority
        ? `<@&${PRIORITY_SUPPORT_ROLE_ID}> 🎧 **PRIORITY TICKET — ${subjectLabel}**`
        : `🎫 **SUPPORT TICKET — ${subjectLabel}**`,
      `**Store:** ${tenant.name || tid}  ·  \`${tid}\``,
      `**Owner:** ${email}`,
      `**Tier:** ${tier} · status: ${status}`,
      `**Ticket:** \`${ticketId}\``,
      '',
      '> ' + message.replace(/\n/g, '\n> '),
      hasScreenshot ? '📎 _Screenshot attached below._' : '',
      '',
      isPriority
        ? `_SLA: 4 business hours. Reply via email to ${email}._`
        : `_General support (Growth) — no SLA. Reply via email to ${email}._`
    ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');

    try {
      // NOTE: Discord's API treats `allowed_mentions.parse: ['roles']`
      // and `allowed_mentions.roles: [...]` as mutually exclusive — using
      // BOTH returns HTTP 400. We use the explicit roles array form so
      // only this specific role ID can be pinged from the content (defense
      // against accidental @everyone if the content ever has it).
      const payloadJson = { content, allowed_mentions: isPriority ? { roles: [PRIORITY_SUPPORT_ROLE_ID] } : { parse: [] } };
      const m = hasScreenshot && screenshotDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      let res;
      if (m) {
        // Attach the screenshot as a real Discord file upload (multipart).
        // Node 22 has global FormData/Blob/Buffer/fetch.
        const mime = m[1];
        const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const buf = Buffer.from(m[2], 'base64');
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payloadJson));
        form.append('files[0]', new Blob([buf], { type: mime }), `ticket-${ticketId}.${ext}`);
        res = await fetch(webhook, { method: 'POST', body: form });
      } else {
        res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadJson)
        });
      }
      if (!res.ok) {
        // Log the response body for diagnosis — Discord 400s usually
        // explain what's wrong in the body, otherwise we're flying blind.
        let body = '';
        try { body = await res.text(); } catch (_) {}
        console.warn('[submitSupportTicket] Discord webhook returned', res.status, body.slice(0, 500));
      }
    } catch (err) {
      console.warn('[submitSupportTicket] Discord post failed:', err.message);
      // Don't fail the call — the audit record is already written and
      // a superadmin can see the ticket in Firestore.
    }
  } else {
    console.warn('[submitSupportTicket] no support webhook configured; ticket recorded in Firestore only');
  }

  return { ticketId };
});

// ============================================================
// CUSTOM DOMAIN (Pro-only, self-serve)
//
// Pro tenants point their own domain (e.g. tindahanjacob.com) at their
// Pabili Mart storefront. Flow:
//   1. Tenant submits domain → submitCustomDomain creates the resource
//      via Firebase Hosting REST API + returns DNS records to display
//   2. Tenant updates DNS at their registrar
//   3. Tenant polls verifyCustomDomain until ownership + cert are active
//   4. Once live, public/customDomains map is updated → storefront head
//      IIFE resolves hostname → tenant slug on first paint
//
// Security posture (see Custom Domain - Self-Serve vs Manual Decision):
//   - These callables run as a DEDICATED runtime SA (see CUSTOM_DOMAIN_SA
//     below) — NOT the default Cloud Functions SA. So a bug in any other
//     callable (e.g. submitSupportTicket) cannot reach Firebase Hosting.
//   - That SA holds a CUSTOM IAM role granting only firebasehosting.sites.*
//     permissions — not full firebasehosting.admin.
//   - Every mutation validates Pro tier + tenant ownership BEFORE the API
//     call, with rate limiting via a 30-min cooldown window per tenant.
// ============================================================

const { GoogleAuth } = require('google-auth-library');

// Dedicated runtime service account for custom-domain callables. Granted
// the "Pabili Mart Custom Domain Manager" custom IAM role + datastore.user
// + logs.writer. Set via Console — see Obsidian custom-domain decision doc.
const CUSTOM_DOMAIN_SA = 'pabilimart-customdomain-sa@jt-sari-sari-store.iam.gserviceaccount.com';

// Firebase Hosting site to attach custom domains to. Default site = project ID.
const FIREBASE_HOSTING_SITE_ID = 'jt-sari-sari-store';
const FIREBASE_PROJECT_ID = 'jt-sari-sari-store';

// Domain validation. Lowercased, RFC 1035-ish (no underscore, no leading
// hyphen, 1–253 chars total, labels 1–63). We also reject pabilimart.com
// itself + obvious abuse vectors (localhost, IPs).
const DOMAIN_REGEX = /^(?=.{1,253}$)(?!:\/\/)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BLOCKED_DOMAINS = new Set([
  'pabilimart.com', 'www.pabilimart.com',
  'jsminimart.com', 'www.jsminimart.com',
  'jt-sari-sari-store.web.app', 'jt-sari-sari-store.firebaseapp.com',
  'localhost'
]);

function validateCustomDomain(raw) {
  const d = String(raw || '').trim().toLowerCase();
  if (!d) throw new HttpsError('invalid-argument', 'Domain is required.');
  if (d.length > 253) throw new HttpsError('invalid-argument', 'Domain is too long.');
  if (!DOMAIN_REGEX.test(d)) {
    throw new HttpsError('invalid-argument', 'That doesn\'t look like a valid domain. Use the form yourstore.com or shop.yourstore.com (no http://, no path).');
  }
  if (BLOCKED_DOMAINS.has(d)) {
    throw new HttpsError('invalid-argument', 'That domain is reserved.');
  }
  // Reject IPs (the regex above mostly catches them but defense-in-depth).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) {
    throw new HttpsError('invalid-argument', 'IP addresses aren\'t supported. Use a registered domain.');
  }
  return d;
}

// ------ Firebase Hosting REST API helpers ------
//
// Auth: ADC inside Cloud Functions uses the function's runtime SA. We
// scope the token to firebase.hosting so it can call the customDomains
// subresource.
//
// All API responses are logged (truncated) so future field-name drift is
// debuggable without redeploying. If a parse fails, the raw response is
// still in Cloud Logging.
let __hostingAuthClient = null;
async function getHostingAuthClient() {
  if (__hostingAuthClient) return __hostingAuthClient;
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform']
  });
  __hostingAuthClient = await auth.getClient();
  return __hostingAuthClient;
}

async function callHostingApi(method, path, body) {
  const client = await getHostingAuthClient();
  const url = `https://firebasehosting.googleapis.com${path}`;
  const headers = { 'Content-Type': 'application/json' };
  const tokenRes = await client.getAccessToken();
  if (tokenRes && tokenRes.token) headers.Authorization = `Bearer ${tokenRes.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    console.warn('[customDomain] Hosting API', method, path, '→', res.status, text.slice(0, 500));
    throw new HttpsError('internal', (parsed && parsed.error && parsed.error.message) || `Firebase Hosting API returned ${res.status}.`);
  }
  return parsed;
}

// Map Firebase Hosting API response into our compact internal status.
// Field names per v1beta1 docs: hostState, ownershipState, certState.
// We keep the raw fields too so the admin UI can show finer detail.
function deriveCustomDomainStatus(apiResp) {
  if (!apiResp) return { status: 'unknown' };
  const hostState = apiResp.hostState || 'HOST_STATE_UNSPECIFIED';
  const ownershipState = apiResp.ownershipState || 'OWNERSHIP_STATE_UNSPECIFIED';
  const certState = (apiResp.cert && apiResp.cert.state) || apiResp.certState || 'CERT_STATE_UNSPECIFIED';
  // Health: a domain is "live" when host is HOST_ACTIVE + cert is CERT_ACTIVE.
  if (hostState === 'HOST_ACTIVE' && (certState === 'CERT_ACTIVE' || certState === 'CERT_EXPIRING_SOON')) {
    return { status: 'live', hostState, ownershipState, certState };
  }
  if (certState === 'CERT_EXPIRED') {
    return { status: 'failed', reason: 'SSL certificate expired.', hostState, ownershipState, certState };
  }
  if (hostState === 'HOST_ACTIVE' || certState === 'CERT_PROPAGATING' || certState === 'CERT_VALIDATING' || certState === 'CERT_PREPARING') {
    return { status: 'ssl_pending', hostState, ownershipState, certState };
  }
  if (ownershipState === 'OWNERSHIP_PENDING' || ownershipState === 'OWNERSHIP_MISSING' || hostState === 'HOST_UNREACHABLE' || hostState === 'HOST_UNHOSTED') {
    return { status: 'dns_pending', hostState, ownershipState, certState };
  }
  if (ownershipState === 'OWNERSHIP_CONFLICT' || hostState === 'HOST_CONFLICT') {
    return { status: 'failed', reason: 'This domain is already claimed by another Firebase project.', hostState, ownershipState, certState };
  }
  if (ownershipState === 'OWNERSHIP_MISMATCH' || hostState === 'HOST_MISMATCH') {
    return { status: 'failed', reason: 'DNS records don\'t match what Firebase expects.', hostState, ownershipState, certState };
  }
  return { status: 'unknown', hostState, ownershipState, certState };
}

// Pull the DNS records the tenant needs to add at their registrar from
// the API response. Shape is { discovered, desired, checkTime } —
// `desired` is what we display.
function extractDnsRecords(apiResp) {
  if (!apiResp || !apiResp.requiredDnsUpdates) return [];
  const desired = apiResp.requiredDnsUpdates.desired || [];
  const records = [];
  desired.forEach(entry => {
    const name = entry.domainName || entry.name || '@';
    (entry.records || []).forEach(rec => {
      records.push({
        type: rec.type || rec.recordType || 'A',
        name,
        value: rec.rdata || rec.value || rec.target || ''
      });
    });
  });
  return records;
}

// Mirror live custom-domain → slug mappings into public/customDomains so
// storefront pages can resolve `location.hostname` to a tenant on first
// paint without privileged reads.
const CUSTOM_DOMAINS_PUBLIC_REF = () => db.collection('public').doc('customDomains');

async function setPublicCustomDomain(domain, slug) {
  await CUSTOM_DOMAINS_PUBLIC_REF().set({
    [`domains.${domain}`]: slug,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}
async function unsetPublicCustomDomain(domain) {
  await CUSTOM_DOMAINS_PUBLIC_REF().set({
    [`domains.${domain}`]: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// Rate limiting: per-tenant 30-min cooldown between submit attempts.
// Prevents a buggy admin UI loop or malicious caller from burning the
// 20-domain Firebase Hosting quota.
const CUSTOM_DOMAIN_SUBMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Pre-flight ownership + tier check shared across all three callables.
async function assertProTenantOwner(tid, email, isSuperadmin) {
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can manage its custom domain.');
  }
  const tier = (tenant.tier || 'free').toLowerCase();
  if (tier !== 'pro' && !isSuperadmin) {
    throw new HttpsError('failed-precondition', 'Custom domain is a Pro feature. Upgrade your plan first.');
  }
  return { tref, tenant };
}

// ============================================================
// submitCustomDomain — Pro-only. Creates the customDomain resource at
// Firebase Hosting and seeds tenants/{tid}.customDomain with the DNS
// records the tenant needs to add at their registrar.
// ============================================================
exports.submitCustomDomain = onCall({ serviceAccount: CUSTOM_DOMAIN_SA }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  const domain = validateCustomDomain(data.domain);

  const { tref, tenant } = await assertProTenantOwner(tid, email, isSuperadmin);

  // Reject if this tenant already has a customDomain in any non-terminal
  // state. They must removeCustomDomain first.
  const existing = tenant.customDomain || null;
  if (existing && existing.domain && existing.status !== 'failed') {
    throw new HttpsError('failed-precondition', `You already have a custom domain (${existing.domain}, status: ${existing.status}). Remove it before adding another.`);
  }
  // Rate limit submits per tenant.
  if (existing && existing.submittedAt) {
    const lastMs = existing.submittedAt.toMillis ? existing.submittedAt.toMillis() : new Date(existing.submittedAt).getTime();
    if (Date.now() - lastMs < CUSTOM_DOMAIN_SUBMIT_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', 'Please wait at least 30 minutes between custom domain submissions.');
    }
  }

  // Create the customDomain at Firebase Hosting. The customDomainId is
  // the actual domain name; per Google docs, the resource name format is
  // projects/{project}/sites/{site}/customDomains/{domain}.
  const createPath = `/v1beta1/projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains?customDomainId=${encodeURIComponent(domain)}`;
  const createResp = await callHostingApi('POST', createPath, {});
  console.log('[submitCustomDomain] create response:', JSON.stringify(createResp).slice(0, 800));

  // The create call returns a Long Running Operation. We immediately GET
  // the resource to pull the DNS records — Firebase populates
  // requiredDnsUpdates synchronously after the create.
  const getPath = `/v1beta1/projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains/${encodeURIComponent(domain)}`;
  let getResp = null;
  try {
    getResp = await callHostingApi('GET', getPath);
    console.log('[submitCustomDomain] get response:', JSON.stringify(getResp).slice(0, 800));
  } catch (err) {
    // If GET fails right after CREATE, the resource may not be ready yet —
    // tenant can re-poll via verifyCustomDomain.
    console.warn('[submitCustomDomain] post-create GET failed (will rely on verify):', err.message);
  }

  const status = getResp ? deriveCustomDomainStatus(getResp) : { status: 'dns_pending' };
  const dnsRecords = getResp ? extractDnsRecords(getResp) : [];

  const customDomain = {
    domain,
    status: status.status,
    statusReason: status.reason || null,
    hostState: status.hostState || null,
    ownershipState: status.ownershipState || null,
    certState: status.certState || null,
    dnsRecords,
    firebaseResourceName: (getResp && getResp.name) || `projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains/${domain}`,
    submittedAt: FieldValue.serverTimestamp(),
    lastCheckedAt: FieldValue.serverTimestamp(),
    liveAt: null
  };
  await tref.update({ customDomain });

  return { ok: true, domain, status: customDomain.status, dnsRecords };
});

// ============================================================
// verifyCustomDomain — Pro-only. Re-polls Firebase Hosting for the latest
// status of the tenant's pending custom domain. Updates Firestore +
// public/customDomains when the domain transitions to live.
// ============================================================
exports.verifyCustomDomain = onCall({ serviceAccount: CUSTOM_DOMAIN_SA }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');

  const { tref, tenant } = await assertProTenantOwner(tid, email, isSuperadmin);
  const existing = tenant.customDomain || null;
  if (!existing || !existing.domain) {
    throw new HttpsError('failed-precondition', 'No custom domain submitted yet.');
  }
  const domain = existing.domain;

  const getPath = `/v1beta1/projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains/${encodeURIComponent(domain)}`;
  const getResp = await callHostingApi('GET', getPath);
  console.log('[verifyCustomDomain]', domain, 'response:', JSON.stringify(getResp).slice(0, 800));

  const status = deriveCustomDomainStatus(getResp);
  const dnsRecords = extractDnsRecords(getResp);

  const patch = {
    'customDomain.status': status.status,
    'customDomain.statusReason': status.reason || null,
    'customDomain.hostState': status.hostState || null,
    'customDomain.ownershipState': status.ownershipState || null,
    'customDomain.certState': status.certState || null,
    'customDomain.dnsRecords': dnsRecords,
    'customDomain.lastCheckedAt': FieldValue.serverTimestamp()
  };
  // Transition to live: stamp liveAt + add to public lookup map.
  if (status.status === 'live' && existing.status !== 'live') {
    patch['customDomain.liveAt'] = FieldValue.serverTimestamp();
    await setPublicCustomDomain(domain, tid);
  }
  // Transition away from live (failed, removed externally): unlist from public map.
  if (status.status !== 'live' && existing.status === 'live') {
    await unsetPublicCustomDomain(domain);
  }
  await tref.update(patch);

  return { ok: true, domain, status: status.status, dnsRecords };
});

// ============================================================
// removeCustomDomain — Pro tenant owner (or superadmin) tears down the
// custom domain. Deletes the customDomain at Firebase Hosting, clears the
// tenants/{tid}.customDomain field, and removes the public/customDomains entry.
// ============================================================
exports.removeCustomDomain = onCall({ serviceAccount: CUSTOM_DOMAIN_SA }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');

  // Skip Pro check on removal — even downgraded tenants must be able to
  // tear down their custom domain to free up the quota slot. So we only
  // do ownership validation here.
  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can manage its custom domain.');
  }
  const existing = tenant.customDomain || null;
  if (!existing || !existing.domain) {
    return { ok: true, alreadyRemoved: true };
  }
  const domain = existing.domain;

  // Delete from Firebase Hosting. Tolerate 404 (already gone) so we can
  // always clean up local state without a stuck record.
  try {
    const delPath = `/v1beta1/projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains/${encodeURIComponent(domain)}`;
    await callHostingApi('DELETE', delPath);
  } catch (err) {
    if (err && err.message && /not found|404/i.test(err.message)) {
      console.warn('[removeCustomDomain] Firebase resource already gone for', domain);
    } else {
      throw err;
    }
  }

  // Clear local state + public lookup.
  await tref.update({ customDomain: FieldValue.delete() });
  await unsetPublicCustomDomain(domain);

  return { ok: true, domain };
});

// ============================================================
// checkCustomDomainsHealth — runs daily. Polls Firebase Hosting for every
// tenant currently holding a live custom domain. Detects:
//   - SSL cert expired/expiring → updates status to failed + alerts via Discord
//   - Ownership/DNS reverted (tenant changed registrar) → updates status
//   - Domain still healthy → updates lastCheckedAt
//
// Non-live domains (dns_pending, ssl_pending) are NOT polled here — the
// tenant pulls them from verifyCustomDomain on demand.
// ============================================================
const { onSchedule } = require('firebase-functions/v2/scheduler');

exports.checkCustomDomainsHealth = onSchedule({
  schedule: 'every day 02:00',
  timeZone: 'Asia/Manila',
  serviceAccount: CUSTOM_DOMAIN_SA
}, async () => {
  console.log('[checkCustomDomainsHealth] starting daily run');
  const snap = await db.collection('tenants')
    .where('customDomain.status', '==', 'live')
    .get();
  console.log('[checkCustomDomainsHealth] live domains to check:', snap.size);

  let healthy = 0, degraded = 0, errored = 0;
  const alerts = [];

  for (const doc of snap.docs) {
    const tenant = doc.data() || {};
    const cd = tenant.customDomain || {};
    const domain = cd.domain;
    if (!domain) continue;
    try {
      const getPath = `/v1beta1/projects/${FIREBASE_PROJECT_ID}/sites/${FIREBASE_HOSTING_SITE_ID}/customDomains/${encodeURIComponent(domain)}`;
      const resp = await callHostingApi('GET', getPath);
      const status = deriveCustomDomainStatus(resp);
      const patch = {
        'customDomain.status': status.status,
        'customDomain.statusReason': status.reason || null,
        'customDomain.hostState': status.hostState || null,
        'customDomain.ownershipState': status.ownershipState || null,
        'customDomain.certState': status.certState || null,
        'customDomain.lastCheckedAt': FieldValue.serverTimestamp()
      };
      await doc.ref.update(patch);
      if (status.status === 'live') {
        healthy++;
      } else {
        degraded++;
        await unsetPublicCustomDomain(domain);
        alerts.push(`⚠️ ${tenant.name || doc.id} · \`${domain}\` → status now **${status.status}** (cert: ${status.certState}). ${status.reason || ''}`);
      }
    } catch (err) {
      errored++;
      console.warn('[checkCustomDomainsHealth] failed for', domain, ':', err.message);
    }
  }

  console.log(`[checkCustomDomainsHealth] done: healthy=${healthy}, degraded=${degraded}, errored=${errored}`);

  // Send a Discord summary if anything degraded today.
  if (alerts.length > 0) {
    try {
      const billingSnap = await db.collection('platform').doc('billing').get();
      const billing = billingSnap.exists ? (billingSnap.data() || {}) : {};
      const webhook = billing.prioritySupportWebhook || billing.subscriptionDiscordWebhook || null;
      if (webhook) {
        const content = `🌐 **Custom Domain Health Check — ${alerts.length} issue${alerts.length === 1 ? '' : 's'}**\n\n${alerts.join('\n')}`;
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
      }
    } catch (err) {
      console.warn('[checkCustomDomainsHealth] Discord post failed:', err.message);
    }
  }
});

// ============================================================
// SUBSCRIPTION LIFECYCLE AUTOMATION (Phase C-1)
//
// Daily scheduled function transitions subscriptions through the
// lifecycle state machine:
//
//   trialing  → past_due   (trial ended without payment)
//   active    → past_due   (currentPeriodEnd passed without renewal)
//   active    → cancelled  (cancelAtPeriodEnd=true + currentPeriodEnd reached)
//   past_due  → grace      (after PAST_DUE_DAYS)
//   grace     → suspended  (after GRACE_DAYS)
//   suspended → cancelled  (after SUSPENDED_DAYS)
//
// Transitions are idempotent — re-running the function on the same
// day no-ops when the precondition is already satisfied. Tier mirrors
// (root doc + settings/store) drop to 'free' on cancellation; status
// changes alone don't touch tier (a past_due Pro tenant is still Pro
// internally, just behind on payment).
//
// Discord summary posts to platform/billing.subscriptionDiscordWebhook
// when any tenant transitions, so Jason gets a daily heartbeat.
// ============================================================

// Grace window (days) a tenant keeps their CURRENT tier after the paid
// period ends / a downgrade is scheduled, before dropping to the target
// tier. Longer for Pro than Growth.
function _graceDaysForTier(tier) {
  return tier === 'pro' ? 15 : 7;
}

function _daysBetween(laterDate, earlierTs) {
  if (!earlierTs) return Infinity;
  const earlierMs = earlierTs.toMillis ? earlierTs.toMillis() : new Date(earlierTs).getTime();
  if (!Number.isFinite(earlierMs)) return Infinity;
  return (laterDate.getTime() - earlierMs) / (24 * 60 * 60 * 1000);
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================
// archiveProductsForTier — enforce a tier's product cap by archiving the
// overflow (NOT deleting). Used both on downgrade-drop (lifecycle) and on
// payment/upgrade (re-cap / restore). Idempotent; only writes flags that
// actually change. Orders + customer data are never touched.
//
// Keep-set fill order, until the target cap is reached:
//   1. `retainIds` — the owner's explicit picks during grace (existing only)
//   2. currently-VISIBLE products (archived !== true) — preserves the live
//      set on renewals so we never reshuffle what's already showing; when
//      the owner made NO explicit pick AND the visible set exceeds the cap,
//      this group is shuffled so the cut is random (per spec)
//   3. currently-ARCHIVED products (id order) — restores extras on upgrade
// Everything outside the keep-set gets archived:true.
// ============================================================
async function archiveProductsForTier(tid, targetTier, retainIds) {
  const cap = (SUBSCRIPTION_TIERS[targetTier] || SUBSCRIPTION_TIERS.free).productCap;
  const col = db.collection('tenants').doc(tid).collection('products');
  const snap = await col.get();
  const docs = snap.docs;
  if (docs.length === 0) return { total: 0, kept: 0, archived: 0, cap };

  const idSet = new Set(docs.map(d => d.id));
  const explicit = (Array.isArray(retainIds) ? retainIds : []).map(String).filter(id => idSet.has(id));
  const hasExplicit = explicit.length > 0;

  const keep = new Set();
  for (const id of explicit) { if (keep.size >= cap) break; keep.add(id); }

  if (keep.size < cap) {
    const visible = [], archivedPool = [];
    for (const d of docs) {
      if (keep.has(d.id)) continue;
      if ((d.data() || {}).archived === true) archivedPool.push(d.id);
      else visible.push(d.id);
    }
    // No explicit pick + visible set must be cut → random which survive.
    if (!hasExplicit) _shuffle(visible);
    archivedPool.sort((a, b) => Number(a) - Number(b));
    for (const id of visible)      { if (keep.size >= cap) break; keep.add(id); }
    for (const id of archivedPool) { if (keep.size >= cap) break; keep.add(id); }
  }

  let ops = 0, batch = db.batch();
  const commits = [];
  for (const d of docs) {
    const shouldArchive = !keep.has(d.id);
    if (((d.data() || {}).archived === true) === shouldArchive) continue; // unchanged
    batch.set(d.ref, { archived: shouldArchive }, { merge: true });
    if (++ops >= 450) { commits.push(batch.commit()); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) commits.push(batch.commit());
  await Promise.all(commits);
  return { total: docs.length, kept: keep.size, archived: docs.length - keep.size, cap };
}

// ============================================================
// Dunning emails — branded payment reminders + downgrade notices sent by the
// daily lifecycle. Reuses the Resend pipeline (noreply@mail.pabilimart.com) and
// the same card shell as the sign-in email, so owners get a consistent look.
//
// A full paid lapse sends at most 4 emails; a trial lapse 2:
//   renewal      — active, period ends within 3 days → "renews soon, pay to keep"
//   trialEnding  — trialing, trial ends within 3 days → "trial ends soon"
//   graceStarted — period ended, entered grace → "overdue, N days to pay"  (once)
//   finalWarning — grace ends within ~1.5 days → "last chance before downgrade"
//   dropped      — moved to target tier → "extra products are safe & archived,
//                  restored when you upgrade"                               (once)
//
// Dedup: the time-window reminders (renewal/trialEnding/finalWarning) would
// re-fire on every daily run while inside their window, so `dunningStages` on
// subscription/current records which have been sent this cycle. The transition
// emails (graceStarted/dropped) ride a one-time status change and need no
// dedup. dunningStages is reset to [] on enter-grace, on drop, and on payment
// (confirmManualPayment). At pilot scale the Resend free tier (3,000/mo,
// 100/day) is never the constraint; revisit batching past ~100 drops/day.
// ============================================================
const DUNNING_TIER_LABEL = { free: 'Free', growth: 'Growth', pro: 'Pro' };

function dunningEmailHtml(e) {
  const bullets = (e.bullets && e.bullets.length)
    ? `<ul style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:1.6;color:#4b5563;">${e.bullets.map(b => `<li style="margin:0 0 8px;">${b}</li>`).join('')}</ul>`
    : '';
  const cta = (e.ctaText && e.ctaHref)
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#2563eb;">
          <a href="${escAttr(e.ctaHref)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${e.ctaText}</a>
        </td></tr></table>`
    : '';
  const foot = e.footnote ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#9ca3af;">${e.footnote}</p>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:26px 32px;">
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">🛒 Pabili Mart</div>
      </td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${e.heading}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#4b5563;">${e.intro}</p>
        ${bullets}${cta}${foot}
      </td></tr>
      <tr><td style="padding:18px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#9ca3af;">Pabili Mart · Your neighborhood store, online.</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function dunningEmailText(e) {
  const bullets = (e.bullets && e.bullets.length)
    ? '\n\n' + e.bullets.map(b => '• ' + String(b).replace(/<[^>]+>/g, '')).join('\n')
    : '';
  const cta = (e.ctaText && e.ctaHref) ? `\n\n${e.ctaText.replace(/[→\s]+$/, '').trim()}: ${e.ctaHref}` : '';
  const foot = e.footnote ? `\n\n${String(e.footnote).replace(/<[^>]+>/g, '')}` : '';
  return `${e.heading}\n\n${String(e.intro).replace(/<[^>]+>/g, '')}${bullets}${cta}${foot}`;
}

// Build the per-stage copy. ctx: { tid, storeName, tier, amount, daysLeft?,
// toTier?, cap?, archivedCount? }.
function buildDunningEmail(stage, ctx) {
  const adminUrl = `https://pabilimart.com/${ctx.tid}/admin/`;
  const tierName = DUNNING_TIER_LABEL[ctx.tier] || ctx.tier;
  const toName = DUNNING_TIER_LABEL[ctx.toTier] || ctx.toTier;
  const d = ctx.daysLeft, dLabel = `${d} day${d === 1 ? '' : 's'}`;
  const safeFoot = `Your orders and customer data are always safe. Already paid? You can ignore this — payments can take a little while to confirm.`;
  switch (stage) {
    case 'renewal':
      return {
        subject: `Your Pabili Mart ${tierName} plan renews in ${dLabel}`,
        heading: `Your ${tierName} plan renews soon`,
        intro: `Hi ${ctx.storeName}, your Pabili Mart ${tierName} plan (₱${ctx.amount}/month) is due in ${dLabel}. Send your GCash payment to keep your store running without interruption.`,
        bullets: null,
        ctaText: 'Open Billing →', ctaHref: adminUrl,
        footnote: safeFoot
      };
    case 'trialEnding':
      return {
        subject: `Your Pabili Mart free trial ends in ${dLabel}`,
        heading: `Your free trial ends in ${dLabel}`,
        intro: `Hi ${ctx.storeName}, your ${tierName} free trial ends in ${dLabel}. To keep your ${tierName} features, send your first GCash payment (₱${ctx.amount}/month) before it ends — otherwise your store moves to Free.`,
        bullets: null,
        ctaText: `Keep ${tierName} →`, ctaHref: adminUrl,
        footnote: safeFoot
      };
    case 'graceStarted':
      return {
        subject: `Action needed: your Pabili Mart payment is overdue`,
        heading: `Your payment is overdue`,
        intro: `Hi ${ctx.storeName}, we haven't received your ${tierName} payment, so your store is now in a ${ctx.graceDays}-day grace period. Pay now to stay on ${tierName} with everything as-is.`,
        bullets: [
          `If we don't receive payment by the end of the grace period, your store moves to <strong>${toName}</strong>.`,
          `Products beyond the ${toName} limit of ${ctx.cap} would be <strong>archived, not deleted</strong> — hidden from your storefront but kept in your admin, and restored the moment you upgrade.`,
          `Your orders and customer data are always safe.`
        ],
        ctaText: 'Pay & keep my plan →', ctaHref: adminUrl,
        footnote: `Already paid? You can ignore this — payments can take a little while to confirm.`
      };
    case 'finalWarning':
      return {
        subject: `Final reminder: your store changes to ${toName} tomorrow`,
        heading: `Last chance to keep ${tierName}`,
        intro: `Hi ${ctx.storeName}, your grace period ends in about a day. Without payment, your store will automatically move to <strong>${toName}</strong> and any products beyond the limit of ${ctx.cap} will be archived (kept safe in your admin, not deleted).`,
        bullets: null,
        ctaText: 'Pay now →', ctaHref: adminUrl,
        footnote: `Already paid? You can ignore this — payments can take a little while to confirm.`
      };
    case 'dropped':
      return {
        subject: `Your Pabili Mart plan is now ${toName}`,
        heading: `Your store is now on ${toName}`,
        intro: `Hi ${ctx.storeName}, your plan has changed to <strong>${toName}</strong>.`,
        bullets: [
          (ctx.archivedCount > 0
            ? `${ctx.archivedCount} product${ctx.archivedCount === 1 ? ' was' : 's were'} archived to fit the ${toName} limit of ${ctx.cap}. They're hidden from your storefront but still in your admin — nothing was deleted.`
            : `Your whole catalog fits within the ${toName} limit, so all your products are still visible.`),
          `Upgrade anytime to instantly bring your archived products back.`,
          `Your orders and customer data are untouched.`
        ],
        ctaText: 'View plans →', ctaHref: adminUrl,
        footnote: null
      };
    default:
      return null;
  }
}

async function sendDunningEmail(recipients, stage, ctx) {
  if (!recipients || recipients.length === 0) return false;
  if (!process.env.RESEND_API_KEY) { console.warn('[dunning] RESEND_API_KEY missing — skipping', stage); return false; }
  const e = buildDunningEmail(stage, ctx);
  if (!e) return false;
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: recipients, subject: e.subject, html: dunningEmailHtml(e), text: dunningEmailText(e) })
    });
  } catch (err) {
    console.warn('[dunning] Resend request failed', stage, err.message);
    return false;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[dunning] Resend non-2xx', stage, res.status, body);
    return false;
  }
  console.log('[dunning] sent', stage, 'to', recipients.join(','), 'for', ctx.tid);
  return true;
}

exports.runSubscriptionLifecycle = onSchedule({
  schedule: 'every day 03:00',
  timeZone: 'Asia/Manila',
  secrets: ['RESEND_API_KEY']
}, async () => {
  console.log('[runSubscriptionLifecycle] starting daily run');
  const now = new Date();

  // Iterate all tenants. At pilot scale (<10K tenants) this is fine —
  // ~10K reads per day = $0.006/mo at $0.06 per 100K reads. Collection-
  // group on subscription/current with composite indexes would be more
  // efficient at 100K+ tenants; not worth the index setup now.
  let tenantsSnap;
  try {
    tenantsSnap = await db.collection('tenants').get();
  } catch (err) {
    console.error('[runSubscriptionLifecycle] tenants read failed:', err.message);
    return;
  }
  console.log('[runSubscriptionLifecycle] scanning', tenantsSnap.size, 'tenants');

  const transitions = [];
  let scanned = 0, unchanged = 0, errored = 0;

  for (const tenantDoc of tenantsSnap.docs) {
    scanned++;
    const tid = tenantDoc.id;
    const tenantData = tenantDoc.data() || {};
    const subRef = tenantDoc.ref.collection('subscription').doc('current');
    let subSnap;
    try {
      subSnap = await subRef.get();
    } catch (err) {
      errored++;
      console.warn('[runSubscriptionLifecycle] subscription read failed for', tid, ':', err.message);
      continue;
    }
    if (!subSnap.exists) { unchanged++; continue; }
    const sub = subSnap.data() || {};
    const status = (sub.status || 'active').toLowerCase();
    const tier = (sub.tier || 'free').toLowerCase();

    // Free tier never transitions (no renewal, no trial).
    if (tier === 'free') { unchanged++; continue; }

    const trialEnd = sub.trialEndsAt;
    const periodEnd = sub.currentPeriodEnd;
    const graceEndsAt = sub.graceEndsAt;
    const scheduledTier = String(sub.scheduledTier || '').toLowerCase();

    // Dunning setup — owner recipients + per-cycle sent-stage dedup. maybeDun
    // only sends a window reminder once per cycle; transition emails are sent
    // inline below (they ride one-time status changes, no dedup needed).
    const recipients = (Array.isArray(tenantData.ownerEmails) ? tenantData.ownerEmails : [])
      .map(e => String(e || '').trim().toLowerCase())
      .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    const sentStages = Array.isArray(sub.dunningStages) ? sub.dunningStages.slice() : [];
    const newlySent = [];
    const baseCtx = { tid, storeName: tenantData.name || 'there', tier, amount: (SUBSCRIPTION_TIERS[tier] || {}).amount || 0 };
    const maybeDun = async (stage, ctx) => {
      if (sentStages.includes(stage)) return;
      if (await sendDunningEmail(recipients, stage, ctx)) { sentStages.push(stage); newlySent.push(stage); }
    };

    // Decide the single transition for this tenant today, if any.
    //   enterGrace : active period ended (unpaid OR scheduled downgrade) →
    //                keep the current tier through a grace window
    //   drop       : grace window elapsed (or a trial expired with no pay) →
    //                move to the target tier + archive the catalog to its cap
    let action = null;

    // 1. Trial expired, never paid → drop straight to Free (no grace).
    if (status === 'trialing' && trialEnd && _daysBetween(now, trialEnd) >= 0) {
      action = { kind: 'drop', fromTier: tier, toTier: 'free', label: `trialing→free (trial expired)` };
    }
    // 2. Paid period ended → enter grace on the current tier. Target is the
    //    scheduled downgrade tier if the owner chose one, else Free
    //    (non-payment always lands on Free). A renewal pushes currentPeriodEnd
    //    into the future, so only lapsed/scheduled tenants reach here.
    else if (status === 'active' && periodEnd && _daysBetween(now, periodEnd) >= 0) {
      const toTier = (scheduledTier === 'growth' || scheduledTier === 'free') ? scheduledTier : 'free';
      const graceDays = _graceDaysForTier(tier);
      action = {
        kind: 'enterGrace',
        fromTier: tier,
        toTier,
        graceDays,
        graceEnds: new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000),
        label: `active→grace (${tier}, ${graceDays}d → ${toTier})`
      };
    }
    // 3. Grace window elapsed → drop to the target tier + archive catalog.
    else if (status === 'grace' && graceEndsAt && _daysBetween(now, graceEndsAt) >= 0) {
      const toTier = String(sub.graceToTier || 'free').toLowerCase();
      action = { kind: 'drop', fromTier: String(sub.graceFromTier || tier).toLowerCase(), toTier, label: `grace→${toTier} (drop)` };
    }

    // No transition today → maybe send a time-window reminder, then move on.
    // The boundaries are mutually exclusive with the transitions above (a
    // reminder needs the deadline in the FUTURE; a transition needs it past),
    // so reminders only land in this no-action branch.
    if (!action) {
      try {
        if (status === 'active' && periodEnd) {
          const daysLeft = Math.ceil(-_daysBetween(now, periodEnd));
          if (daysLeft > 0 && daysLeft <= 3) await maybeDun('renewal', { ...baseCtx, daysLeft });
        } else if (status === 'trialing' && trialEnd) {
          const daysLeft = Math.ceil(-_daysBetween(now, trialEnd));
          if (daysLeft > 0 && daysLeft <= 3) await maybeDun('trialEnding', { ...baseCtx, daysLeft });
        } else if (status === 'grace' && graceEndsAt) {
          const daysLeft = -_daysBetween(now, graceEndsAt);
          if (daysLeft > 0 && daysLeft <= 1.5) {
            const toTier = String(sub.graceToTier || 'free').toLowerCase();
            await maybeDun('finalWarning', { ...baseCtx, toTier, cap: (SUBSCRIPTION_TIERS[toTier] || {}).productCap });
          }
        }
        if (newlySent.length > 0) await subRef.set({ dunningStages: sentStages }, { merge: true });
      } catch (derr) {
        console.warn('[runSubscriptionLifecycle] dunning reminder failed for', tid, ':', derr.message);
      }
      unchanged++; continue;
    }

    try {
      if (action.kind === 'enterGrace') {
        await subRef.update({
          status: 'grace',
          graceSince: FieldValue.serverTimestamp(),
          graceEndsAt: action.graceEnds,
          graceFromTier: action.fromTier,
          graceToTier: action.toTier,
          dunningStages: [] // fresh window for the grace-period reminders
        });
        // graceStarted notice (one-time — status just left 'active').
        await maybeDun('graceStarted', {
          ...baseCtx, toTier: action.toTier, graceDays: action.graceDays,
          cap: (SUBSCRIPTION_TIERS[action.toTier] || {}).productCap
        }).catch(() => {});
      } else { // drop
        const toTier = action.toTier;
        // Archive the catalog down to the target tier's cap (honoring the
        // owner's retain picks, else random). Free/Growth have caps; pro
        // would keep everything. Best-effort: a failure here still drops
        // the tier so the store isn't stuck paying for a tier it lost.
        const retainIds = Array.isArray(sub.pendingRetainIds) ? sub.pendingRetainIds : [];
        try {
          action.archiveInfo = await archiveProductsForTier(tid, toTier, retainIds);
        } catch (aerr) {
          console.warn('[runSubscriptionLifecycle] archive failed for', tid, ':', aerr.message);
        }
        const patch = {
          tier: toTier,
          status: 'active',
          amount: (SUBSCRIPTION_TIERS[toTier] || SUBSCRIPTION_TIERS.free).amount,
          scheduledTier: null,
          cancelAtPeriodEnd: false,
          cancellationRequestedAt: null,
          graceSince: null, graceEndsAt: null, graceFromTier: null, graceToTier: null,
          pendingRetainIds: null,
          trialEndsAt: null,
          dunningStages: [], // cycle ended; next paid cycle (Growth) starts clean
          droppedAt: FieldValue.serverTimestamp(),
          droppedFromTier: action.fromTier
        };
        if (toTier === 'free') {
          patch.amount = 0;
          patch.currentPeriodStart = FieldValue.serverTimestamp();
          patch.currentPeriodEnd = null; // Free never renews
        } else {
          // Voluntary downgrade to a paid tier (e.g. Pro→Growth): start a
          // fresh 30-day period at the new tier's rate; the next manual
          // renewal is billed at that rate.
          patch.currentPeriodStart = FieldValue.serverTimestamp();
          patch.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        }
        await subRef.update(patch);
        // Mirror the tier so storefront branding + admin cap revert.
        await tenantDoc.ref.update({ tier: toTier });
        await tenantDoc.ref.collection('settings').doc('store').set({ tier: toTier }, { merge: true });
        // dropped notice (one-time — this transition only fires once).
        await maybeDun('dropped', {
          ...baseCtx, toTier,
          cap: action.archiveInfo ? action.archiveInfo.cap : (SUBSCRIPTION_TIERS[toTier] || {}).productCap,
          archivedCount: action.archiveInfo ? action.archiveInfo.archived : 0
        }).catch(() => {});
      }
      transitions.push({
        tid,
        name: tenantData.name || tid,
        label: action.label + (action.archiveInfo ? ` [kept ${action.archiveInfo.kept}/${action.archiveInfo.cap}, archived ${action.archiveInfo.archived}]` : ''),
        tier
      });
    } catch (err) {
      errored++;
      console.warn('[runSubscriptionLifecycle] write failed for', tid, ':', err.message);
    }
  }

  console.log(`[runSubscriptionLifecycle] done: scanned=${scanned}, transitions=${transitions.length}, unchanged=${unchanged}, errored=${errored}`);

  // Discord summary if anything transitioned.
  if (transitions.length > 0) {
    try {
      const billingSnap = await db.collection('platform').doc('billing').get();
      const billing = billingSnap.exists ? (billingSnap.data() || {}) : {};
      const webhook = billing.subscriptionDiscordWebhook || billing.prioritySupportWebhook || null;
      if (webhook) {
        const lines = transitions.map(t => `• **${t.name}** (\`${t.tid}\`, ${t.tier}) → ${t.label}`);
        const content = [
          `📅 **Subscription Lifecycle — Daily Run**`,
          `${transitions.length} transition${transitions.length === 1 ? '' : 's'} (scanned ${scanned}):`,
          '',
          lines.join('\n')
        ].join('\n');
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
      }
    } catch (err) {
      console.warn('[runSubscriptionLifecycle] Discord post failed:', err.message);
    }
  }
});

// ============================================================
// cancelSubscription — tenant owner (or superadmin) requests cancellation.
// Sets cancelAtPeriodEnd=true; the tenant keeps access through their
// currentPeriodEnd. The daily lifecycle function does the actual
// transition to 'cancelled' + drops the tier mirror at that date.
// Cancellation is reversible until period end via reactivateSubscription.
//
// For trialing subscriptions, cancellation is immediate (no period end
// they're paying through) — status flips to cancelled now.
// ============================================================
exports.cancelSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  const reason = String(data.reason || '').trim().slice(0, 500);
  // Target of the downgrade — defaults to Free ("Cancel plan"); a Pro tenant
  // can also schedule a downgrade to Growth.
  const targetTier = String(data.targetTier || 'free').toLowerCase();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');

  const TIER_RANK = { free: 0, growth: 1, pro: 2 };
  if (targetTier === 'pro' || !(targetTier in TIER_RANK)) {
    throw new HttpsError('invalid-argument', 'You can only downgrade to Free or Growth.');
  }

  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can change its subscription.');
  }

  const subRef = tref.collection('subscription').doc('current');
  const subSnap = await subRef.get();
  if (!subSnap.exists) throw new HttpsError('failed-precondition', 'No subscription to change.');
  const sub = subSnap.data() || {};
  const status = (sub.status || 'active').toLowerCase();
  const tier = (sub.tier || 'free').toLowerCase();

  if (tier === 'free') throw new HttpsError('failed-precondition', 'You\'re already on the free plan.');
  if (TIER_RANK[targetTier] >= TIER_RANK[tier]) {
    throw new HttpsError('failed-precondition', 'That isn\'t a downgrade from your current plan.');
  }

  // Trialing → can't schedule (nothing paid through). A trial downgrade ends
  // the trial NOW and drops straight to Free, archiving the catalog to the
  // Free cap. (Downgrading a trial to Growth isn't supported — cancel and
  // start a Growth plan instead.)
  if (status === 'trialing') {
    try { await archiveProductsForTier(tid, 'free', []); }
    catch (err) { console.warn('[cancelSubscription] trial archive failed for', tid, ':', err.message); }
    await subRef.update({
      tier: 'free',
      status: 'active',
      amount: 0,
      currentPeriodStart: FieldValue.serverTimestamp(),
      currentPeriodEnd: null,
      trialEndsAt: null,
      scheduledTier: null,
      graceSince: null, graceEndsAt: null, graceFromTier: null, graceToTier: null,
      pendingRetainIds: null,
      cancelAtPeriodEnd: false,
      cancellationReason: reason || 'trial_cancelled_by_tenant',
      droppedAt: FieldValue.serverTimestamp(),
      droppedFromTier: tier
    });
    await tref.update({ tier: 'free' });
    await tref.collection('settings').doc('store').set({ tier: 'free' }, { merge: true });
    return { ok: true, mode: 'immediate', targetTier: 'free' };
  }

  // Active → schedule the downgrade at period end. The daily lifecycle runs
  // active→grace (when currentPeriodEnd passes) → drop to scheduledTier.
  // Reversible via reactivateSubscription before period end.
  await subRef.update({
    scheduledTier: targetTier,
    cancelAtPeriodEnd: targetTier === 'free', // back-compat flag for to-Free
    cancellationRequestedAt: FieldValue.serverTimestamp(),
    cancellationReason: reason || 'tenant_requested'
  });
  return { ok: true, mode: 'at_period_end', targetTier };
});

// ============================================================
// reactivateSubscription — clears cancelAtPeriodEnd before the period
// end is reached, so the tenant continues to be billed normally.
// Only meaningful when status === 'active' AND cancelAtPeriodEnd === true.
// ============================================================
exports.reactivateSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');

  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can reactivate its subscription.');
  }

  const subRef = tref.collection('subscription').doc('current');
  const subSnap = await subRef.get();
  if (!subSnap.exists) throw new HttpsError('failed-precondition', 'No subscription found.');
  const sub = subSnap.data() || {};
  const hasSchedule = !!sub.scheduledTier || sub.cancelAtPeriodEnd === true;
  if (!hasSchedule) {
    throw new HttpsError('failed-precondition', 'No scheduled downgrade to undo.');
  }
  if ((sub.status || '').toLowerCase() !== 'active') {
    throw new HttpsError('failed-precondition', 'Only an active subscription can undo a scheduled downgrade. If you\'re already in grace, submit a payment to stay on your current plan.');
  }

  await subRef.update({
    scheduledTier: null,
    cancelAtPeriodEnd: false,
    cancellationRequestedAt: null,
    cancellationReason: null,
    reactivatedAt: FieldValue.serverTimestamp()
  });
  return { ok: true };
});

// ============================================================
// setRetainProducts — owner picks which products stay visible after a
// pending downgrade (during the scheduled-active or grace window). Writes
// subscription.pendingRetainIds, which the lifecycle drop honors. Capped at
// the target tier's product cap. Subscription is server-write-only (rules),
// so this must go through a callable.
// ============================================================
exports.setRetainProducts = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  const email = token.email;
  const isSuperadmin = SUPERADMIN_EMAILS.has(email);

  const data = request.data || {};
  const tid = String(data.tid || '').trim();
  if (!tid) throw new HttpsError('invalid-argument', 'tid is required');
  // De-dupe + stringify the incoming ids.
  const productIds = Array.from(new Set((Array.isArray(data.productIds) ? data.productIds : []).map(String)));

  const tref = db.collection('tenants').doc(tid);
  const tsnap = await tref.get();
  if (!tsnap.exists) throw new HttpsError('not-found', 'Tenant not found.');
  const tenant = tsnap.data() || {};
  const ownerEmails = Array.isArray(tenant.ownerEmails) ? tenant.ownerEmails : [];
  if (!isSuperadmin && !ownerEmails.includes(email)) {
    throw new HttpsError('permission-denied', 'Only this store\'s owner can choose its retained products.');
  }

  const subRef = tref.collection('subscription').doc('current');
  const subSnap = await subRef.get();
  if (!subSnap.exists) throw new HttpsError('failed-precondition', 'No subscription found.');
  const sub = subSnap.data() || {};
  const status = (sub.status || 'active').toLowerCase();
  // Only meaningful while a downgrade is pending — grace, or active with a
  // scheduledTier set.
  const targetTier = status === 'grace'
    ? String(sub.graceToTier || 'free').toLowerCase()
    : String(sub.scheduledTier || '').toLowerCase();
  if (!targetTier) {
    throw new HttpsError('failed-precondition', 'No pending downgrade — nothing to pre-select.');
  }
  const cap = (SUBSCRIPTION_TIERS[targetTier] || SUBSCRIPTION_TIERS.free).productCap;
  if (productIds.length > cap) {
    throw new HttpsError('invalid-argument', `You can keep at most ${cap} products on the ${targetTier} plan.`);
  }

  await subRef.update({ pendingRetainIds: productIds });
  return { ok: true, count: productIds.length, cap, targetTier };
});

// ============================================================
// ACTIVITY LOG (audit trail) — Phase 0. Tamper-proof per-tenant history of
// key events, written ONLY by Firestore triggers (Admin SDK) into the
// immutable tenants/{tid}/activity/{id} collection (client write denied in
// rules). Each entry sets expiresAt = +90d for a TTL policy. Idempotent via a
// deterministic doc id. Actor comes from the `_actor` field the admin client
// stamps on the write (falls back to confirmedBy/updatedBy, else system).
// Plan: Obsidian "Activity Log (Audit Trail) - Plan.md".
// ============================================================
const ACTIVITY_TTL_DAYS = 90;

async function logActivity(tid, eventId, entry) {
  if (!tid || !eventId) return;
  try {
    await db.collection('tenants').doc(tid).collection('activity').doc(eventId).set({
      ...entry,
      tid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + ACTIVITY_TTL_DAYS * 24 * 60 * 60 * 1000)
    });
  } catch (err) {
    console.warn('[activity] write failed for', tid, eventId, ':', err.message);
  }
}

// Derive the actor for an audit entry from a doc's data. Prefers the stamped
// `_actor` {uid,email,role}; falls back to legacy actor fields; else system.
function activityActor(data) {
  const a = data && data._actor;
  if (a && typeof a === 'object') {
    return { uid: a.uid || null, email: a.email || null, role: a.role || 'owner' };
  }
  if (data && data.confirmedBy) return { uid: null, email: data.confirmedBy, role: 'owner' };
  if (data && data.updatedBy)   return { uid: null, email: data.updatedBy, role: 'owner' };
  return { uid: null, email: null, role: 'system' };
}

function shortOrderId(oid) { return String(oid || '').slice(-6).toUpperCase(); }

// ---- Orders: created (customer placed) + status transitions ----
exports.onOrderCreated = onDocumentCreated('tenants/{tid}/orders/{oid}', async (event) => {
  const { tid, oid } = event.params;
  const d = event.data ? event.data.data() : null;
  if (!d) return;
  const total = Number(d.total || 0);
  const cust = (d.customer && d.customer.name) || 'a customer';
  await logActivity(tid, `ord-new-${oid}`, {
    type: 'order.placed', category: 'orders', targetId: oid,
    summary: `New order #${shortOrderId(oid)} — ₱${total.toFixed(2)} from ${cust}`,
    after: { status: d.status || 'pending', total },
    actor: { uid: null, email: null, role: 'customer' },
    source: 'trigger'
  });
});

exports.onOrderUpdated = onDocumentUpdated('tenants/{tid}/orders/{oid}', async (event) => {
  const { tid, oid } = event.params;
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after) return;
  if (before.status === after.status) return; // only log status transitions
  const typeMap = { confirmed: 'order.confirmed', cancelled: 'order.cancelled', refunded: 'order.refunded' };
  const type = typeMap[after.status] || 'order.updated';
  const actor = activityActor(after);
  await logActivity(tid, `ord-${after.status}-${oid}`, {
    type, category: 'orders', targetId: oid,
    summary: `Order #${shortOrderId(oid)} → ${after.status}${actor.email ? ' by ' + actor.email : ''}`,
    before: { status: before.status }, after: { status: after.status },
    actor, source: 'trigger'
  });
});

// The admin client stamps `_actor` + `_actorAt` (serverTimestamp) on deliberate
// writes. Because Firestore merges persist `_actor` on the doc, a LATER write by
// a customer (checkout stock decrement) or the system (storefront auto-close)
// would still carry the stale `_actor` — so presence alone is not enough. We log
// only when `_actorAt` ADVANCED in this write, i.e. an admin freshly stamped it.
function actorIsFresh(before, after) {
  const b = before && before._actorAt;
  const a = after && after._actorAt;
  if (!a) return false;          // no fresh-actor marker → customer/system write
  if (!b) return true;           // first stamp on this doc
  try { return !a.isEqual(b); } catch (e) {
    try { return a.toMillis() !== b.toMillis(); } catch (e2) { return true; }
  }
}

function pickProductFields(d) {
  return {
    name: d.name != null ? d.name : null,
    price: d.price != null ? d.price : null,
    stock: d.stock != null ? d.stock : null,
    available: d.available != null ? d.available : null,
    hidden: d.hidden != null ? d.hidden : null
  };
}

// ---- Products: create / delete / field changes (admin-driven only) ----
// Logged only when an admin freshly stamped the write, which excludes bulk
// starter-catalog seeds, server seeds, customer checkout decrements, and
// order-cancel/confirm restocks (none advance `_actorAt`).
exports.onProductCreated = onDocumentCreated('tenants/{tid}/products/{pid}', async (event) => {
  const { tid, pid } = event.params;
  const d = event.data ? event.data.data() : null;
  if (!d || !d._actorAt) return; // admin-added only (bulk/seed creates carry no _actorAt)
  const actor = activityActor(d);
  await logActivity(tid, `prod-create-${pid}`, {
    type: 'product.created', category: 'products', targetId: String(pid),
    summary: `Added product "${d.name || pid}"${actor.email ? ' by ' + actor.email : ''}`,
    after: pickProductFields(d),
    actor, source: 'trigger'
  });
});

exports.onProductDeleted = onDocumentDeleted('tenants/{tid}/products/{pid}', async (event) => {
  const { tid, pid } = event.params;
  const d = event.data ? event.data.data() : null; // the deleted doc's last data
  if (!d) return;
  if (d.fromStarterCatalog === true) return; // skip bulk-catalog removals / re-seeds
  const actor = activityActor(d); // best-effort: last stamped _actor on the doc
  await logActivity(tid, `prod-delete-${pid}`, {
    type: 'product.deleted', category: 'products', targetId: String(pid),
    summary: `Deleted product "${d.name || pid}"${actor.email ? ' by ' + actor.email : ''}`,
    before: pickProductFields(d),
    actor, source: 'trigger'
  });
});

exports.onProductUpdated = onDocumentUpdated('tenants/{tid}/products/{pid}', async (event) => {
  const { tid, pid } = event.params;
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after) return;
  if (!actorIsFresh(before, after)) return; // admin action only (skips customer/restock)
  const changes = [];
  if (Number(before.stock) !== Number(after.stock)) {
    changes.push(`stock ${before.stock != null ? before.stock : '—'}→${after.stock != null ? after.stock : '—'}`);
  }
  if (Number(before.price) !== Number(after.price)) changes.push(`price ₱${before.price}→₱${after.price}`);
  if (before.name !== after.name) changes.push(`renamed "${before.name}"→"${after.name}"`);
  if ((before.available !== false) !== (after.available !== false)) {
    changes.push(after.available === false ? 'marked out of stock' : 'marked available');
  }
  if (!!before.hidden !== !!after.hidden) changes.push(after.hidden ? 'hidden from storefront' : 'shown on storefront');
  if (changes.length === 0) return; // metadata-only / no meaningful change
  const onlyStock = changes.length === 1 && Number(before.stock) !== Number(after.stock);
  const actor = activityActor(after);
  await logActivity(tid, `prod-upd-${pid}-${event.id}`, {
    type: onlyStock ? 'stock.adjusted' : 'product.updated', category: 'products', targetId: String(pid),
    summary: `${after.name || before.name || 'Product'} — ${changes.join(', ')}${actor.email ? ' by ' + actor.email : ''}`,
    before: pickProductFields(before), after: pickProductFields(after),
    actor, source: 'trigger'
  });
});

// ---- Payments: manual GCash confirm / reject (server-written) ----
exports.onPaymentUpdated = onDocumentUpdated('tenants/{tid}/payments/{ref}', async (event) => {
  const { tid, ref } = event.params;
  const before = event.data && event.data.before ? event.data.before.data() : null;
  const after = event.data && event.data.after ? event.data.after.data() : null;
  if (!before || !after || before.status === after.status) return;
  const type = after.status === 'confirmed' ? 'payment.received'
             : after.status === 'rejected' ? 'payment.rejected' : null;
  if (!type) return;
  const amount = Number(after.amount || 0);
  const by = after.confirmedBy || after.rejectedBy || null;
  const actor = by ? { uid: null, email: by, role: 'superadmin' } : activityActor(after);
  await logActivity(tid, `pay-${after.status}-${ref}`, {
    type, category: 'payments', targetId: String(ref),
    summary: `Payment ${after.status} — ₱${amount.toFixed(2)}${after.tier ? ' (' + after.tier + ')' : ''}${by ? ' by ' + by : ''}`,
    before: { status: before.status }, after: { status: after.status, amount, tier: after.tier || null },
    actor, source: 'trigger'
  });
});

// ---- Subscription: plan (tier) change ----
exports.onSubscriptionUpdated = onDocumentUpdated('tenants/{tid}/subscription/{sid}', async (event) => {
  if (event.params.sid !== 'current') return;
  const { tid } = event.params;
  const before = event.data && event.data.before ? event.data.before.data() : {};
  const after = event.data && event.data.after ? event.data.after.data() : {};
  if (!before || !after || before.tier === after.tier) return; // tier changes only
  await logActivity(tid, `plan-${after.tier}-${event.id}`, {
    type: 'plan.changed', category: 'billing', targetId: 'subscription',
    summary: `Plan changed: ${before.tier || '—'} → ${after.tier || '—'}`,
    before: { tier: before.tier || null, status: before.status || null },
    after: { tier: after.tier || null, status: after.status || null },
    actor: { uid: null, email: null, role: 'system' }, source: 'trigger'
  });
});

// ---- Operating modes (admin toggle only) — modes live on settings/store
// (tenant default) AND on each branches/{id} doc, so we watch both. ----
const OP_MODE_LABELS = { rainMode: 'Rain Mode', maintenanceMode: 'Maintenance Mode', offlineMode: 'Offline Mode', storeClosed: 'Store Closed' };
async function logModeChanges(tid, before, after, eventId, targetId, scopeLabel) {
  if (!actorIsFresh(before, after)) return; // admin toggle only (skip auto-close + server mirrors)
  const actor = activityActor(after);
  const changes = [];
  Object.keys(OP_MODE_LABELS).forEach(f => {
    if (!!before[f] !== !!after[f]) changes.push(`${OP_MODE_LABELS[f]} ${after[f] ? 'ON' : 'OFF'}`);
  });
  if (changes.length === 0) return;
  await logActivity(tid, `mode-${eventId}`, {
    type: 'mode.changed', category: 'store', targetId,
    summary: `${changes.join(', ')}${scopeLabel ? ' [' + scopeLabel + ']' : ''}${actor.email ? ' by ' + actor.email : ''}`,
    actor, source: 'trigger'
  });
}

exports.onSettingsUpdated = onDocumentUpdated('tenants/{tid}/settings/{sid}', async (event) => {
  if (event.params.sid !== 'store') return;
  const before = event.data && event.data.before ? event.data.before.data() : {};
  const after = event.data && event.data.after ? event.data.after.data() : {};
  await logModeChanges(event.params.tid, before || {}, after || {}, event.id, 'settings', null);
});

exports.onBranchUpdated = onDocumentUpdated('tenants/{tid}/branches/{bid}', async (event) => {
  const before = event.data && event.data.before ? event.data.before.data() : {};
  const after = event.data && event.data.after ? event.data.after.data() : {};
  const label = (after && after.name) ? after.name : event.params.bid;
  await logModeChanges(event.params.tid, before || {}, after || {}, event.id, event.params.bid, label);
});

// ============================================================
// storefrontMeta — per-tenant link-preview (OpenGraph) SSR.
// ------------------------------------------------------------
// Wired to the storefront `**` Hosting rewrite. Link-unfurl crawlers
// (Messenger/Facebook/Twitter/etc.) do NOT run JS, so they only ever see the
// static index.html — whose meta tags would otherwise show the seed tenant
// ("Pabili Mart" default). This function resolves the tenant from the request
// (path slug, or custom-domain host), looks up its storeName, and returns
// index.html with the <title> + OG/Twitter tags rewritten to that store.
//
// Robustness: this is the storefront's main entry, so it must NEVER break the
// page. Any error / unknown tenant → return the canonical index.html unchanged.
// The full HTML is served (not just meta) so the SPA hydrates normally.
//
// Cost/latency: responses are CDN-cached per path (s-maxage), so after the
// first hit per slug the CDN serves it with no function invocation. The
// canonical index.html is fetched from the Hosting origin (static files bypass
// this rewrite, so no recursion and no duplicate file to keep in sync) and
// memoized per warm instance with a short TTL.
// ============================================================
const SHELL_URL = 'https://jt-sari-sari-store.web.app/index.html';
const OG_DESCRIPTION = 'Order from your neighborhood store, carinderia, or café — delivered or for pickup.';
const META_SLUG_BLOCKLIST = new Set([
  'admin', 'checkout', 'signup', 'auth', 'superadmin',
  'assets', 'static', 'public', 'api', 'index.html', 'favicon.ico'
]);

let __shellCache = { html: null, at: 0 };
async function getShellHtml() {
  const now = Date.now();
  if (__shellCache.html && (now - __shellCache.at) < 600000) return __shellCache.html; // 10-min TTL
  const res = await fetch(SHELL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('shell fetch ' + res.status);
  const html = await res.text();
  __shellCache = { html, at: now };
  return html;
}

// Escape for an HTML attribute value (and text). Quotes + angle brackets + amp.
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolve the tenant slug for an incoming storefront request.
async function resolveSlugForRequest(host, pathname) {
  // 1. Path-based: pabilimart.com/{slug}/... — slug is the first segment.
  const parts = String(pathname || '').split('/').filter(Boolean);
  const first = (parts[0] || '').toLowerCase();
  if (first && !META_SLUG_BLOCKLIST.has(first)) return first;
  // 2. Custom domain: resolve host → slug via public/customDomains.
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  const isPlatform = !h || h.endsWith('.web.app') || h.endsWith('.firebaseapp.com')
    || h === 'pabilimart.com' || h === 'www.pabilimart.com'
    || h === 'jsminimart.com' || h === 'www.jsminimart.com'
    || h === 'localhost' || h === '127.0.0.1';
  if (!isPlatform) {
    try {
      const snap = await db.collection('public').doc('customDomains').get();
      const map = (snap.exists ? (snap.data() || {}).domains : {}) || {};
      if (map[h]) return String(map[h]).toLowerCase();
    } catch (_) { /* fall through */ }
  }
  return null;
}

// Look up the public-facing store name for a slug. Prefers the freshest source
// (settings/store), falling back to the tenant root doc.
async function lookupStoreName(slug) {
  try {
    const ss = await db.collection('tenants').doc(slug).collection('settings').doc('store').get();
    if (ss.exists && ss.data() && ss.data().storeName) return String(ss.data().storeName);
  } catch (_) { /* ignore */ }
  try {
    const t = await db.collection('tenants').doc(slug).get();
    if (t.exists && t.data() && t.data().storeName) return String(t.data().storeName);
  } catch (_) { /* ignore */ }
  // Seed tenant predates the SaaS schema — its name was never written to
  // settings/store; the client hardcodes it (STORE.name in index.html). Mirror
  // that here so jsminimart's links unfurl as "JS Mini Mart", not the default.
  if (slug === 'jsminimart') return 'JS Mini Mart';
  return null;
}

// Send an HTML response compressed per the client's Accept-Encoding (brotli or
// gzip). Function / Cloud Run responses are NOT auto-compressed by Hosting (only
// static files are), so the storefront would otherwise ship ~5x larger than the
// static-served brotli size. Vary: Accept-Encoding keeps the CDN caching per
// encoding. Falls back to plain text if compression ever throws — never breaks.
function sendHtml(req, res, html, cacheControl) {
  res.set('Cache-Control', cacheControl);
  res.set('Vary', 'Accept-Encoding');
  res.type('html');
  const ae = String((req.headers && req.headers['accept-encoding']) || '');
  try {
    if (/\bbr\b/.test(ae)) {
      const buf = zlib.brotliCompressSync(Buffer.from(html, 'utf8'),
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
      res.set('Content-Encoding', 'br');
      res.status(200).send(buf);
      return;
    }
    if (/\bgzip\b/.test(ae)) {
      res.set('Content-Encoding', 'gzip');
      res.status(200).send(zlib.gzipSync(Buffer.from(html, 'utf8')));
      return;
    }
  } catch (err) {
    console.error('storefrontMeta compress failed:', err);
  }
  res.status(200).send(html); // uncompressed fallback
}

exports.storefrontMeta = onRequest({ region: 'asia-southeast1', maxInstances: 10, invoker: 'public' }, async (req, res) => {
  let html = null;
  try {
    html = await getShellHtml();
  } catch (e) {
    // Can't even fetch the shell — minimal safe page rather than a 500.
    console.error('storefrontMeta shell fetch failed:', e);
    res.set('Cache-Control', 'no-store');
    res.status(200).type('html').send('<!DOCTYPE html><meta http-equiv="refresh" content="0">');
    return;
  }
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const pathname = (req.path || req.url || '/').split('?')[0];
    const slug = await resolveSlugForRequest(host, pathname);
    const name = slug ? await lookupStoreName(slug) : null;
    if (name) {
      const title = escAttr(name);
      const desc = escAttr(`Order online from ${name} — delivery or pick-up from your neighborhood store. Powered by Pabili Mart.`);
      const canonical = escAttr('https://pabilimart.com' + pathname);
      // Per-tenant OG card (name + logo), rendered + CDN-cached by ogImage.
      const imageUrl = escAttr('https://pabilimart.com/og/' + encodeURIComponent(slug) + '.png');
      html = html
        .replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
        .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${title}$2`)
        .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${title}$2`)
        .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${desc}$2`)
        .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${desc}$2`)
        .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${desc}$2`)
        .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/i, `$1${canonical}$2`)
        .replace(/(<meta\s+property="og:image"\s+content=")[^"]*(")/i, `$1${imageUrl}$2`)
        .replace(/(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i, `$1${imageUrl}$2`);
    }
    // CDN-cache per path so warm previews + repeat loads skip the function.
    // Short window so a store rename / new tenant reflects quickly.
    sendHtml(req, res, html, 'public, max-age=600, s-maxage=600');
  } catch (e) {
    // Injection failed — serve the unmodified shell so the store never breaks.
    console.error('storefrontMeta inject failed:', e);
    sendHtml(req, res, html, 'no-store');
  }
});

// ============================================================
// ogImage — per-tenant OpenGraph card PNG (name + logo on the brand card).
// ------------------------------------------------------------
// Served at /og/{slug}.png (Hosting rewrite). storefrontMeta points each
// tenant's og:image here. Rendered with satori + resvg (see ogcard.js) and
// CDN-cached per slug, so it's generated rarely (crawlers cache ~30 days).
// On any error / unknown tenant → redirect to the static og-default.png so a
// link always has SOME image.
// ============================================================
const OG_DEFAULT_URL = 'https://pabilimart.com/og-default.png';

// The tenant's custom logo data URL, only when the logo feature is on.
async function lookupLogoDataUrl(slug) {
  try {
    const ss = await db.collection('tenants').doc(slug).collection('settings').doc('store').get();
    const d = ss.exists ? (ss.data() || {}) : {};
    if (d.logoEnabled === true && typeof d.logoDataUrl === 'string' && d.logoDataUrl.startsWith('data:image/')) {
      return d.logoDataUrl;
    }
  } catch (_) { /* ignore */ }
  return null;
}

exports.ogImage = onRequest({ region: 'asia-southeast1', maxInstances: 10, memory: '512MiB', invoker: 'public' }, async (req, res) => {
  try {
    // /og/{slug}.png → slug
    const pathname = (req.path || req.url || '/').split('?')[0];
    const m = pathname.match(/\/og\/([^/]+?)(?:\.png)?$/i);
    const slug = m ? decodeURIComponent(m[1]).toLowerCase() : null;
    const name = slug ? await lookupStoreName(slug) : null;
    if (!slug || !name) { res.redirect(302, OG_DEFAULT_URL); return; }

    const logoDataUrl = await lookupLogoDataUrl(slug);
    const { renderOgCardPng } = require('./ogcard'); // lazy — only ogImage needs satori/resvg
    const png = await renderOgCardPng({ name, logoDataUrl });

    // Long CDN cache — the card only changes on rename/logo change, which is
    // rare and tolerates the same re-scrape delay as the title.
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.set('Content-Type', 'image/png');
    res.status(200).send(png);
  } catch (e) {
    console.error('ogImage render failed:', e);
    res.redirect(302, OG_DEFAULT_URL);
  }
});

// ============================================================
// sendStoreSignInLink — branded signup email via Resend.
// ------------------------------------------------------------
// Replaces Firebase's built-in verification email (which sends from the shared
// firebaseapp.com domain with a raw, unmasked link). This sends a SIGN-IN link
// (continue → /signup/) — clicking it signs the owner in on any device, marks
// the email verified, and lands them on the store-setup form — from
// noreply@mail.pabilimart.com with a masked "Verify & continue" button.
//
// Abuse guards: caller must be SIGNED IN AS the target email (so you can only
// request a link for your own account), plus a per-email throttle (cooldown +
// daily cap) so it can't be looped to spam an inbox or burn the email quota.
// Scoped to the email/password path; the passwordless magic-link keeps
// Firebase's built-in send. Future hardening: App Check.
// ============================================================
const SIGNIN_CONTINUE_URL = 'https://pabilimart.com/signup/';
const MAIL_FROM = 'Pabili Mart <noreply@mail.pabilimart.com>';
const SIGNIN_COOLDOWN_MS = 30 * 1000;   // min gap between sends to one email
const SIGNIN_DAILY_CAP = 8;             // max sends per email per 24h
const SIGNIN_IP_HOURLY_CAP = 15;        // max unauthenticated (magic-link) sends per IP per hour

// Two flavors: 'verify' (new email/password account confirming) and 'signin'
// (passwordless magic-link — could be a new OR returning owner).
function emailCopy(isSignin) {
  return isSignin
    ? { subject: 'Your Pabili Mart sign-in link', heading: 'Sign in to Pabili Mart',
        body: 'Tap the button below to securely sign in and continue to your store.',
        cta: 'Sign in →',
        textLead: 'Open this link to securely sign in to Pabili Mart:' }
    : { subject: 'Verify your email for Pabili Mart', heading: 'Confirm your email',
        body: 'Tap the button below to verify your email and finish setting up your store — it brings you straight to your store setup.',
        cta: 'Verify &amp; continue →',
        textLead: 'Open this link to verify your email and finish setting up your store:' };
}
function signInEmailHtml(link, isSignin) {
  const href = escAttr(link); const c = emailCopy(isSignin);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:26px 32px;">
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">🛒 Pabili Mart</div>
      </td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${c.heading}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#4b5563;">${c.body}</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#2563eb;">
          <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${c.cta}</a>
        </td></tr></table>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#9ca3af;">This link is unique to you — please don't share it. If you didn't request this, you can safely ignore this email.</p>
      </td></tr>
      <tr><td style="padding:18px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#9ca3af;">Pabili Mart · Your neighborhood store, online.</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
function signInEmailText(link, isSignin) {
  const c = emailCopy(isSignin);
  return `${c.heading}\n\n${c.textLead}\n${link}\n\nThis link is unique to you — please don't share it. If you didn't request this, ignore this email.`;
}

exports.sendStoreSignInLink = onCall({ region: 'asia-southeast1', secrets: ['RESEND_API_KEY'], maxInstances: 10 }, async (request) => {
  const email = String((request.data && request.data.email) || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  // Self-authed (email/password verify/resend) vs unauthenticated (passwordless
  // magic-link). A signed-in user may ONLY request their own email's link; the
  // magic-link case has no account yet, so it's allowed but throttled harder.
  const authEmail = request.auth && request.auth.token ? String(request.auth.token.email || '').toLowerCase() : '';
  const isSelfAuthed = !!authEmail && authEmail === email;
  if (authEmail && !isSelfAuthed) {
    throw new HttpsError('permission-denied', 'You can only request a link for your own account.');
  }
  const now = Date.now();
  // Per-email throttle (cooldown + daily cap) — applies to every request.
  const emailRef = db.collection('_signinLinkThrottle').doc(Buffer.from(email).toString('hex'));
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(emailRef)).data() || {};
    if (typeof d.lastSentAt === 'number' && now - d.lastSentAt < SIGNIN_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', 'Please wait a few seconds before requesting another link.');
    }
    let windowStart = typeof d.windowStart === 'number' ? d.windowStart : now;
    let count = typeof d.count === 'number' ? d.count : 0;
    if (now - windowStart > 24 * 3600 * 1000) { windowStart = now; count = 0; }
    if (count >= SIGNIN_DAILY_CAP) {
      throw new HttpsError('resource-exhausted', 'Too many link requests today. Please try again later.');
    }
    tx.set(emailRef, { lastSentAt: now, windowStart, count: count + 1 }, { merge: true });
  });
  // Per-IP throttle — only for the unauthenticated magic-link path (the authed
  // path is already gated to the user's own email). Limits scripted abuse from
  // a single source across many different emails.
  if (!isSelfAuthed) {
    const xff = (request.rawRequest && request.rawRequest.headers && request.rawRequest.headers['x-forwarded-for']) || '';
    const ip = (Array.isArray(xff) ? xff[0] : String(xff)).split(',')[0].trim()
      || (request.rawRequest && request.rawRequest.ip) || '';
    if (ip) {
      const ipRef = db.collection('_signinLinkIpThrottle').doc(Buffer.from(ip).toString('hex'));
      await db.runTransaction(async (tx) => {
        const d = (await tx.get(ipRef)).data() || {};
        let windowStart = typeof d.windowStart === 'number' ? d.windowStart : now;
        let count = typeof d.count === 'number' ? d.count : 0;
        if (now - windowStart > 3600 * 1000) { windowStart = now; count = 0; } // 1-hour window
        if (count >= SIGNIN_IP_HOURLY_CAP) {
          throw new HttpsError('resource-exhausted', 'Too many requests. Please try again later.');
        }
        tx.set(ipRef, { windowStart, count: count + 1 }, { merge: true });
      });
    }
  }
  // Generate the Firebase sign-in link (continue → /signup/).
  let link;
  try {
    link = await getAuth().generateSignInWithEmailLink(email, { url: SIGNIN_CONTINUE_URL, handleCodeInApp: true });
  } catch (err) {
    console.error('generateSignInWithEmailLink failed:', err);
    throw new HttpsError('internal', 'Could not generate your sign-in link.');
  }
  // Send via Resend. Magic-link gets "sign in" copy; verify gets "confirm email".
  const isSignin = !isSelfAuthed;
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to: [email],
        subject: emailCopy(isSignin).subject,
        html: signInEmailHtml(link, isSignin), text: signInEmailText(link, isSignin)
      })
    });
  } catch (err) {
    console.error('Resend request failed:', err);
    throw new HttpsError('internal', 'Could not send the email. Please try again.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Resend non-2xx:', res.status, body);
    throw new HttpsError('internal', 'The email service rejected the request.');
  }
  return { ok: true };
});
