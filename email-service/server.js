const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Create transporter using Gmail
const transporter = nodemailer.createTransporter({
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
    const { email, otp } = req.body;
    
    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Email and OTP are required'
      });
    }
    
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