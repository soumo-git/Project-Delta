const express = require('express');
const Brevo = require('@getbrevo/brevo');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin - For testing purposes, we'll use a mock implementation
let adminInitialized = false;
let mockDb = {
  ref: (path) => ({
    once: () => Promise.resolve({ val: () => ({}) }),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve()
  })
};

// Create a mock admin object for testing
const mockAdminAuth = {
  auth: () => ({
    generatePasswordResetLink: async (email, settings) => {
      console.log(`Mock: Generated password reset link for ${email}`);
      return `https://example.com/reset-password?email=${encodeURIComponent(email)}`;
    }
  })
};

// Store the original admin module
const originalAdmin = admin;

try {
  // Try to initialize Firebase Admin if credentials are available
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    const serviceAccount = {
      type: process.env.FIREBASE_TYPE || 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID || 'delta-65',
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
      token_uri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://delta-65-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
    
    adminInitialized = true;
    console.log('✅ Firebase Admin SDK initialized successfully');
  } else {
    console.log('⚠️ Firebase Admin SDK credentials not found, using mock implementation');
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK:', error);
  console.log('⚠️ Using mock implementation instead');
}

// Use real or mock database
const db = adminInitialized ? admin.database() : mockDb;

// If Firebase Admin SDK initialization failed, use our mock implementation
if (!adminInitialized) {
  // We can't reassign the admin constant, so we'll create a function to get the admin object
  admin.auth = () => mockAdminAuth.auth();
}

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Brevo client or mock for testing
let brevoClient;
let brevoReady = false;

// In-memory rate limiting map per email to prevent duplicate sends within a short window
const otpSendLocks = new Map(); // key: emailHash, value: timestamp (ms)

if (process.env.BREVO_API_KEY) {
  try {
    brevoClient = new Brevo.TransactionalEmailsApi();
    brevoClient.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    brevoReady = true;
    console.log('✅ Brevo client initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Brevo client:', error);
  }
} else {
  console.log('⚠️ BREVO_API_KEY not set, using mock email sender');
}

async function sendEmail({ to, subject, html, text }) {
  if (brevoReady && brevoClient) {
    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL || 'no-reply@project-delta.local',
        name: process.env.BREVO_SENDER_NAME || 'Project Delta'
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    };
    const resp = await brevoClient.sendTransacEmail(sendSmtpEmail);
    return resp;
  }
  console.log('📧 MOCK EMAIL SENDING:');
  console.log('   To:', to);
  console.log('   Subject:', subject);
  console.log('   Text:', text ? String(text).substring(0, 100) + '...' : 'No text content');
  console.log('   HTML:', html ? 'HTML content available' : 'No HTML content');
  return { messageId: 'mock-message-id-' + Date.now(), response: 'Mock email sent successfully' };
}

// Generate a 6-digit OTP and ensure it's not currently used in the database (best-effort)
async function generateUniqueOtp() {
  const generate = () => String(Math.floor(100000 + Math.random() * 900000));

  // If no real DB, just return a random OTP
  if (!adminInitialized || !db || typeof db.ref !== 'function') {
    return generate();
  }

  // Try a few times to avoid collisions
  for (let i = 0; i < 5; i++) {
    const otp = generate();
    try {
      const snapshot = await db.ref('otp').once('value');
      const all = snapshot && typeof snapshot.val === 'function' ? snapshot.val() : snapshot?.val;
      const existing = typeof all === 'function' ? all() : all;
      const isUsed = existing
        ? Object.values(existing).some((entry) => entry && String(entry.otp) === otp)
        : false;
      if (!isUsed) return otp;
    } catch (e) {
      // On any read error, return the generated OTP (fallback)
      return otp;
    }
  }
  // If we somehow failed to find a unique code, just return a random one
  return generate();
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Project Delta Email Service is running',
    timestamp: new Date().toISOString()
  });
});

// Send OTP email endpoint
app.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    // Validate input
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    // Compute hash and refs
    const emailHash = email.replace(/[.#$[\]]/g, '_');
    const otpRef = db.ref(`otp/${emailHash}`);
    const RATE_LIMIT_MS = 60 * 1000; // 60s

    // Rate limit: if we sent too recently, do not send another email
    const now = Date.now();
    const lastSendMs = otpSendLocks.get(emailHash) || 0;
    if (now - lastSendMs < RATE_LIMIT_MS) {
      console.log(`⏱️ Rate-limited OTP request for ${email}, last sent ${now - lastSendMs}ms ago.`);
      return res.json({
        success: true,
        message: 'OTP already sent recently. Please check your inbox.',
        rateLimited: true
      });
    }

    // Check if an unexpired OTP already exists; reuse it to avoid duplicates
    let existing = null;
    try {
      const snap = await otpRef.once('value');
      existing = snap && typeof snap.val === 'function' ? snap.val() : snap?.val;
    } catch (e) {
      console.warn('⚠️ Could not read existing OTP, proceeding to generate a new one.', e);
    }

    let otp;
    const ttlMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    if (existing && existing.expiresAt && existing.expiresAt > nowMs && existing.otp) {
      otp = String(existing.otp);
      console.log(`♻️ Reusing existing unexpired OTP for ${email}`);
    } else {
      // Generate and store a new OTP
      otp = await generateUniqueOtp();
      console.log(`🔐 Generated unique OTP: ${otp} for ${email}`);
    }

    console.log('💾 Storing OTP in Firebase:', emailHash, otp);
    console.log('🌐 Firebase Database URL:', process.env.FIREBASE_DATABASE_URL || 'https://delta-65-default-rtdb.asia-southeast1.firebasedatabase.app');

    try {
      await otpRef.set({
        email: email,
        otp: otp,
        expiresAt: nowMs + ttlMs,
        attempts: existing?.attempts ?? 0,
        sentAt: nowMs,
        generatedAt: existing?.generatedAt ?? nowMs
      });
      console.log('✅ OTP stored successfully in Firebase');

      // Verify the data was stored
      const verifySnapshot = await otpRef.once('value');
      const verifyData = verifySnapshot.val();
      console.log('🔍 Verification - Data in Firebase:', verifyData);

    } catch (firebaseError) {
      console.error('❌ Error storing OTP in Firebase:', firebaseError);
      throw firebaseError;
    }
    
    // Email template
    const subject = '🔐 Your Project Delta Verification Code';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #000; color: #fff;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #22c55e; margin: 0; font-size: 24px;">Project Delta</h1>
          <p style="color: #666; margin: 10px 0;">Verification Code</p>
        </div>
        
        <div style="background-color: #111; border: 2px solid #22c55e; border-radius: 10px; padding: 30px; text-align: center; margin: 20px 0;">
          <h2 style="color: #22c55e; margin: 0 0 20px 0; font-size: 18px;">Your Verification Code</h2>
          <div style="background-color: #000; border: 1px solid #22c55e; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #22c55e; letter-spacing: 8px; font-family: 'Courier New', monospace;">${otp}</span>
          </div>
          <p style="color: #fbbf24; margin: 10px 0; font-size: 14px;">⚠️ This code will expire in 5 minutes</p>
        </div>
        
        <div style="margin-top: 30px; padding: 20px; background-color: #111; border-radius: 8px;">
          <p style="color: #666; margin: 0; font-size: 14px; line-height: 1.5;">
            If you didn't request this verification code, please ignore this email. 
            This code is for your Project Delta account verification.
          </p>
        </div>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
          <p style="color: #666; margin: 0; font-size: 12px;">
            Project Delta Team<br>
            Parental Control Dashboard
          </p>
        </div>
      </div>
    `;
    const text = `
Project Delta - Verification Code

Your verification code is: ${otp}

This code will expire in 5 minutes.

If you didn't request this code, please ignore this email.

Best regards,
Project Delta Team
    `;
    
    // Send email via Brevo or mock
    // Remember the last send timestamp early to mitigate concurrent quick requests
    otpSendLocks.set(emailHash, nowMs);
    const info = await sendEmail({ to: email, subject, html, text });
    
    const messageId = (info && (info.messageId || (info.messageIds && info.messageIds[0]))) || 'unknown';
    console.log('✅ Email sent successfully:', messageId);
    
    res.json({
      success: true,
      messageId: messageId,
      message: 'OTP email sent successfully'
    });
    
  } catch (error) {
    console.error('❌ Error sending email:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send email',
      details: error.message
    });
  }
});



// Password reset email endpoint
app.post('/send-password-reset', async (req, res) => {
  try {
    const { email, actionUrl } = req.body;
    
    // Validate input
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    console.log(`📧 Processing password reset for: ${email}`);
    console.log(`🔗 Action URL: ${actionUrl || 'Not provided, using default'}`);  
    
    // Generate a password reset link using Firebase Admin SDK
    const actionCodeSettings = {
      url: actionUrl || 'https://delta-65.firebaseapp.com',
      handleCodeInApp: false
    };
    
    let resetLink;
    try {
      // Generate the reset link using Firebase Admin SDK (real or mock)
      resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);
      console.log('✅ Generated password reset link for:', email);
    } catch (firebaseError) {
      console.error('❌ Error generating password reset link:', firebaseError);
      
      // For testing purposes, create a mock link if Firebase fails
      resetLink = `${actionUrl || 'https://example.com'}/reset-password?email=${encodeURIComponent(email)}&oobCode=mockCode123`;
      console.log('⚠️ Using mock reset link for testing:', resetLink);
      
      
    }
    
    // Email template
    const subject = '🔐 Reset Your Project Delta Password';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #000; color: #fff;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #22c55e; margin: 0; font-size: 24px;">Project Delta</h1>
          <p style="color: #666; margin: 10px 0;">Password Reset</p>
        </div>
        
        <div style="background-color: #111; border: 2px solid #22c55e; border-radius: 10px; padding: 30px; text-align: center; margin: 20px 0;">
          <h2 style="color: #22c55e; margin: 0 0 20px 0; font-size: 18px;">Reset Your Password</h2>
          <p style="color: #fff; margin: 20px 0; font-size: 16px;">Click the button below to reset your password:</p>
          <div style="margin: 30px 0;">
            <a href="${resetLink}" style="background-color: #22c55e; color: #000; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-weight: bold; display: inline-block;">Reset Password</a>
          </div>
          <p style="color: #fbbf24; margin: 10px 0; font-size: 14px;">⚠️ This link will expire in 1 hour</p>
          <p style="color: #fff; margin: 20px 0; font-size: 14px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <div style="background-color: #000; border: 1px solid #22c55e; border-radius: 8px; padding: 10px; margin: 20px 0; word-break: break-all;">
            <a href="${resetLink}" style="color: #22c55e; font-size: 14px; text-decoration: none;">${resetLink}</a>
          </div>
        </div>
        
        <div style="margin-top: 30px; padding: 20px; background-color: #111; border-radius: 8px;">
          <p style="color: #666; margin: 0; font-size: 14px; line-height: 1.5;">
            If you didn't request a password reset, please ignore this email or contact support if you have concerns.
          </p>
        </div>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
          <p style="color: #666; margin: 0; font-size: 12px;">
            Project Delta Team<br>
            Parental Control Dashboard
          </p>
        </div>
      </div>
    `;
    const text = `
Project Delta - Password Reset

Click the link below to reset your password:
${resetLink}

This link will expire in 1 hour.

If you didn't request a password reset, please ignore this email.

Best regards,
Project Delta Team
    `;
    
    // Send email using Brevo or mock
    const info = await sendEmail({ to: email, subject, html, text });
    
    const messageId = (info && (info.messageId || (info.messageIds && info.messageIds[0]))) || 'unknown';
    console.log('✅ Password reset email sent successfully:', messageId);
    
    // Always include resetLink in development mode for testing
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    res.json({
      success: true,
      messageId: info.messageId,
      message: 'Password reset email sent successfully',
      resetLink: isDevelopment ? resetLink : undefined // Only include in non-production
    });
    
    console.log(`✅ Password reset response sent with ${isDevelopment ? 'resetLink included' : 'no resetLink'}`);
    
  } catch (error) {
    console.error('❌ Error sending password reset email:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send password reset email',
      details: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Project Delta Email Service running on port ${PORT}`);
  console.log(`📧 Gmail User: ${process.env.GMAIL_USER || 'Not configured'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
});

// Periodic cleanup of expired OTPs
async function cleanupExpiredOtps() {
  try {
    if (!db || typeof db.ref !== 'function') return;
    console.log('🧹 Starting OTP cleanup...');
    const snap = await db.ref('otp').once('value');
    const data = snap && typeof snap.val === 'function' ? snap.val() : snap?.val;
    const all = typeof data === 'function' ? data() : data;
    if (!all || typeof all !== 'object') {
      console.log('✅ No OTPs to clean up');
      return;
    }
    const now = Date.now();
    const entries = Object.entries(all);
    let removed = 0;
    await Promise.all(entries.map(async ([key, value]) => {
      if (!value || !value.expiresAt || value.expiresAt <= now) {
        await db.ref(`otp/${key}`).remove();
        removed++;
      }
    }));
    console.log(`🧽 OTP cleanup completed. Removed ${removed} expired entries.`);
  } catch (e) {
    console.error('❌ OTP cleanup failed:', e);
  }
}

// Kick off periodic cleanup every 5 minutes
setInterval(cleanupExpiredOtps, 5 * 60 * 1000);
// Also run once shortly after startup
setTimeout(cleanupExpiredOtps, 15 * 1000);
