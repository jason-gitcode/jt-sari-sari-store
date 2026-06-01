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

  // ---------- PER-EMAIL TENANT CAP ----------
  // Note: this check is racy under high-concurrency parallel calls from the
  // same user; acceptable for pilot scale (sari-sari store SaaS).
  if (!SUPERADMIN_EMAILS.has(email)) {
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

  // ---------- CREATE (transactional uniqueness check) ----------
  const ref = db.collection('tenants').doc(slug);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      throw new HttpsError('already-exists', 'That store URL is already taken.');
    }
    tx.set(ref, {
      name,
      ownerEmails: [email],
      plan: 'starter',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
      createdByEmail: email
    });
  });

  // ---------- SEED MINIMAL SETTINGS DOC ----------
  // So the storefront has *something* to read on day 1.
  await ref.collection('settings').doc('store').set({
    storeClosed: false,
    rainMode: false,
    maintenanceMode: false,
    storeClosedSource: 'auto'
  });

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

  return {
    slug,
    name,
    url: `https://jsminimart.com/${slug}/`,
    adminUrl: `https://jsminimart.com/${slug}/admin/`,
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
  return { slug, deleted: true };
});
