const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

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

// Lowercase letters/numbers/hyphens, must start with a letter, 3–32 chars.
// No trailing hyphen, no consecutive hyphens.
const SLUG_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLUG_MIN = 3;
const SLUG_MAX = 32;

function validateSlug(raw) {
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
  return slug;
}

function validateName(raw) {
  const name = String(raw || '').trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpsError('invalid-argument',
      'Store name must be 2–100 characters.');
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
  pro:    { name: 'PabiliMart Pro',    amount: 399, productCap: 10000 }
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
  const slug = validateSlug(data.slug);
  const name = validateName(data.name);
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
    // Default of 200 matches the original hardcoded behaviour.
    codMaxAmount: 200,
    // Operating hours (Manila time, 24h). Tenant edits these in admin → Store Info.
    storeOpenHour: 6,
    storeCloseHour: 16,
    // Open days of week (0=Sun, 6=Sat). Default: open every day.
    openDays: [0,1,2,3,4,5,6],
    // Delivery schedule windows. Tenant edits in admin → Service & Payment.
    schedulesEnabled: true,
    deliverySchedules: [
      { start: '10:00', end: '14:00' },
      { start: '14:00', end: '18:00' },
      { start: '16:00', end: '19:00' }
    ],
    // Delivery fee — toggleable + configurable amount (PHP).
    deliveryFeeEnabled: true,
    deliveryFee: 45,
    // Free delivery promotion + delivery areas list — both toggleable.
    freeDeliveryEnabled: true,
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

  // ---------- ADD TO PUBLIC DIRECTORY ----------
  // Non-blocking: directory enables storefront discovery on the signup
  // page, but a failure here shouldn't roll back a successful tenant create.
  try {
    await upsertDirectoryEntry(slug, name);
  } catch (err) {
    console.error('public directory upsert failed for tenant', slug, err);
  }

  return {
    slug,
    name,
    url: `https://pabilimart.com/${slug}/`,
    adminUrl: `https://pabilimart.com/${slug}/admin/`,
    starterPackCopied,
    tier: initialTier,
    tierName: SUBSCRIPTION_TIERS[initialTier].name,
    trialing: initialTier !== 'free'
  };
});

// ============================================================
// deleteTenant — superadmin-only, recursive delete of a tenant doc
// and all its subcollections (products / orders / settings / etc.)
// ============================================================
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
  // recursiveDelete handles arbitrary nesting and large subcollections
  // server-side; far more reliable than client-side per-doc loops.
  await db.recursiveDelete(tref);

  // Remove from public directory (non-blocking; tenant is already gone).
  try {
    await removeDirectoryEntry(slug);
  } catch (err) {
    console.error('public directory remove failed for tenant', slug, err);
  }

  return { slug, deleted: true };
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
    tierSynced++;
  }
  return { seeded, skipped, tierSynced, total: snap.size };
});

// ============================================================
// submitManualPayment — tenant owner submits a manual GCash payment for
// a tier upgrade or renewal. Creates a pending_verification payment doc
// + fires a Discord webhook so the superadmin can confirm in real time.
//
// Validation: requested tier exists, amount matches tier price, receipt
// is a reasonable size (compressed client-side), tenant owns the tid.
//
// Idempotency: the reference code (`PM-{slug}-{YYYYMM}`) is the doc ID,
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
  });

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
  const referenceCode = `PM-${tid}-${period}`;

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

  await db.runTransaction(async (tx) => {
    const psnap = await tx.get(pref);
    if (!psnap.exists) throw new HttpsError('not-found', 'Payment not found.');
    const p = psnap.data() || {};
    if (p.status !== 'pending_verification') {
      throw new HttpsError('failed-precondition', `Payment is not pending (status: ${p.status}).`);
    }
    const tier = p.tier;
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
      suspendedAt: null,
      cancelledAt: null,
      cancellationReason: null,
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
  });

  return { paymentId, tid, status: 'confirmed' };
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

  return {
    email,
    isSuperadmin,
    cap: isSuperadmin ? null : MAX_TENANTS_PER_EMAIL,
    tenants: snap.docs.map(d => {
      const data = d.data() || {};
      return {
        slug: d.id,
        name: data.name || d.id,
        url: `https://pabilimart.com/${d.id}/`,
        adminUrl: `https://pabilimart.com/${d.id}/admin/`
      };
    })
  };
});
