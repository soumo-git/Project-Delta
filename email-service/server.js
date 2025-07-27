const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
const serviceAccount = {
  type: process.env.FIREBASE_TYPE || 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID || 'delta-65',
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
  token_uri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://delta-65-default-rtdb.firebaseio.com'
});

const db = admin.database();

// Middleware
app.use(cors());
app.use(express.json());

// Create transporter using Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'your-email@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD || 'your-app-password'
  }
});

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
    
    // Generate unique OTP
    const otp = await generateUniqueOtp();
    console.log(`🔐 Generated unique OTP: ${otp} for ${email}`);
    
    // Store OTP in Firebase
    const emailHash = email.replace(/[.#$[\]]/g, '_');
    const otpRef = db.ref(`otp/${emailHash}`);
    await otpRef.update({ 
      otp: otp,
      generatedAt: Date.now()
    });
    
    // Email template
    const mailOptions = {
      from: process.env.GMAIL_USER || 'your-email@gmail.com',
      to: email,
      subject: '🔐 Your Project Delta Verification Code',
      html: `
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
      `,
      text: `
Project Delta - Verification Code

Your verification code is: ${otp}

This code will expire in 5 minutes.

If you didn't request this code, please ignore this email.

Best regards,
Project Delta Team
      `
    };
    
    // Send email
    const info = await transporter.sendMail(mailOptions);
    
    console.log('✅ Email sent successfully:', info.messageId);
    
    res.json({
      success: true,
      messageId: info.messageId,
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

// Generate unique OTP function
async function generateUniqueOtp() {
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Check if OTP already exists in database
    const otpRef = db.ref('otp');
    const snapshot = await otpRef.once('value');
    const otps = snapshot.val();
    
    if (!otps) {
      return otp; // No OTPs exist, this one is unique
    }
    
    // Check if this OTP is already in use
    const otpExists = Object.values(otps).some(otpData => otpData.otp === otp);
    
    if (!otpExists) {
      return otp; // OTP is unique
    }
    
    attempts++;
    console.log(`🔄 OTP ${otp} already exists, generating new one... (attempt ${attempts})`);
  }
  
  throw new Error('Failed to generate unique OTP after maximum attempts');
}

// Cleanup expired OTPs function
async function cleanupExpiredOtps() {
  try {
    console.log('🧹 Starting OTP cleanup...');
    const otpRef = db.ref('otp');
    const snapshot = await otpRef.once('value');
    const otps = snapshot.val();
    
    if (!otps) {
      console.log('✅ No OTPs to clean up');
      return;
    }
    
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [emailHash, otpData] of Object.entries(otps)) {
      if (otpData.expiresAt && now > otpData.expiresAt) {
        await otpRef.child(emailHash).remove();
        cleanedCount++;
        console.log(`🗑️ Cleaned expired OTP for: ${emailHash}`);
      }
    }
    
    console.log(`✅ Cleanup complete. Removed ${cleanedCount} expired OTPs`);
  } catch (error) {
    console.error('❌ Error during OTP cleanup:', error);
  }
}

// Schedule cleanup every 5 minutes
setInterval(cleanupExpiredOtps, 5 * 60 * 1000);

// Run initial cleanup on startup
cleanupExpiredOtps();

// Manual cleanup endpoint
app.post('/cleanup-otps', async (req, res) => {
  try {
    await cleanupExpiredOtps();
    res.json({
      success: true,
      message: 'OTP cleanup completed'
    });
  } catch (error) {
    console.error('❌ Error in manual cleanup:', error);
    res.status(500).json({
      success: false,
      error: 'Cleanup failed'
    });
  }
});

// Test email endpoint
app.post('/test-email', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    const mailOptions = {
      from: process.env.GMAIL_USER || 'your-email@gmail.com',
      to: email,
      subject: '🧪 Project Delta - Email Service Test',
      text: 'This is a test email from Project Delta Email Service on Render. If you receive this, your email setup is working correctly!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #000; color: #fff;">
          <h1 style="color: #22c55e; text-align: center;">🧪 Email Service Test</h1>
          <p style="color: #fff; text-align: center;">This is a test email from Project Delta Email Service on Render.</p>
          <p style="color: #22c55e; text-align: center; font-weight: bold;">✅ If you receive this, your email setup is working correctly!</p>
        </div>
      `
    };
    
    const info = await transporter.sendMail(mailOptions);
    
    res.json({
      success: true,
      messageId: info.messageId,
      message: 'Test email sent successfully!'
    });
    
  } catch (error) {
    console.error('❌ Error sending test email:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
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