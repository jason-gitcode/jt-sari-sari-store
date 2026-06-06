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
  free:   { name: 'PabiliMart Free',   amount: 0,   productCap: 10 },
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
    // Free tier doesn't trial — it's permanently free.
    return {
      tier: 'free',
      status: 'active',
      amount: 0,
      currentPeriodStart: FieldValue.serverTimestamp(),
      currentPeriodEnd: null, // no renewal needed
      trialEndsAt: null,
      pastDueSince: null,
      suspendedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      paymentMethod: null,
      createdAt: FieldValue.serverTimestamp()
    };
  }
  // Paid tier: 30-day trial.
  const trialEnd = new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return {
    tier,
    status: 'trialing',
    amount: tierConfig.amount,
    currentPeriodStart: FieldValue.serverTimestamp(),
    currentPeriodEnd: trialEnd, // trial ends here unless first payment lands
    trialEndsAt: trialEnd,
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
  // same user; acceptable for pilot scale (sari-sari store SaaS).
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
    // Storefront layout — 'grid' (default, sari-sari style) or 'list'
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
    deliveryAreas: []
  });

  // ---------- SEED SUBSCRIPTION DOC ----------
  // New tenants land on PabiliMart Free by default. They can upgrade
  // from the Billing tab. Free has no trial because it's permanently free.
  await ref.collection('subscription').doc('current').set(getInitialSubscription({ tier: 'free' }));

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
    starterPackCopied
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
// backfillSubscriptions — superadmin-only. One-shot migration that gives
// every existing tenant a subscription/current doc (PabiliMart Free,
// active) if they don't already have one. Idempotent — safe to re-run.
// Run once after Phase A ships, then ignore.
// ============================================================
exports.backfillSubscriptions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = request.auth.token || {};
  if (token.email_verified !== true) throw new HttpsError('failed-precondition', 'Email must be verified.');
  if (!SUPERADMIN_EMAILS.has(token.email)) throw new HttpsError('permission-denied', 'Superadmin only.');

  const snap = await db.collection('tenants').get();
  let seeded = 0, skipped = 0;
  for (const doc of snap.docs) {
    const subRef = doc.ref.collection('subscription').doc('current');
    const subSnap = await subRef.get();
    if (subSnap.exists) { skipped++; continue; }
    await subRef.set(getInitialSubscription({ tier: 'free' }));
    seeded++;
  }
  return { seeded, skipped, total: snap.size };
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
