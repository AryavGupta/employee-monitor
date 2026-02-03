/**
 * Email Service for sending user notifications
 * Uses nodemailer for SMTP email delivery
 * Optimized for serverless environments (Vercel)
 */
const nodemailer = require('nodemailer');

/**
 * Create a fresh transporter for each request (required for serverless)
 */
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  // Use Gmail service shortcut if using Gmail
  const isGmail = process.env.SMTP_HOST.includes('gmail');

  if (isGmail) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      // Timeout settings for serverless
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }

  // Generic SMTP configuration
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Timeout settings for serverless
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/**
 * Check if email service is configured
 * @returns {boolean}
 */
function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Send welcome email with login credentials to new user
 * @param {string} userEmail - Recipient email address
 * @param {string} fullName - User's full name
 * @param {string} password - Plain text password (sent only once at creation)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendWelcomeEmail(userEmail, fullName, password) {
  // Create fresh transporter for each request (serverless best practice)
  const transport = createTransporter();

  if (!transport) {
    return { success: false, error: 'Email service not configured' };
  }

  const appName = process.env.APP_NAME || 'Employee Monitor';
  const companyName = process.env.COMPANY_NAME || 'Your Company';

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: userEmail,
    subject: `Welcome to ${appName} - Your Login Credentials`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border: 1px solid #e2e8f0; border-top: none; }
          .credentials { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e2e8f0; }
          .credentials p { margin: 8px 0; }
          .label { color: #64748b; font-size: 14px; }
          .value { font-weight: 600; color: #0f172a; font-size: 16px; }
          .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 20px 0; font-size: 14px; }
          .footer { text-align: center; padding: 20px; color: #64748b; font-size: 12px; }
          .button { display: inline-block; background: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 24px;">Welcome to ${appName}</h1>
            <p style="margin: 10px 0 0; opacity: 0.9;">${companyName}</p>
          </div>
          <div class="content">
            <p>Hello <strong>${fullName}</strong>,</p>
            <p>Your account has been created for the ${appName} desktop application. Please use the credentials below to log in:</p>

            <div class="credentials">
              <p><span class="label">Email:</span><br><span class="value">${userEmail}</span></p>
              <p><span class="label">Password:</span><br><span class="value">${password}</span></p>
            </div>

            <div class="warning">
              <strong>Important:</strong> For security, please change your password after logging in. Go to Settings in the desktop app to update your password.
            </div>

            <p>If you haven't received the desktop application, please contact your administrator.</p>
          </div>
          <div class="footer">
            <p>This is an automated message from ${appName}. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to ${appName}!

Hello ${fullName},

Your account has been created. Here are your login credentials:

Email: ${userEmail}
Password: ${password}

IMPORTANT: For security, please change your password after logging in. Go to Settings in the desktop app to update your password.

If you haven't received the desktop application, please contact your administrator.

This is an automated message from ${appName}.
    `.trim(),
  };

  try {
    const info = await transport.sendMail(mailOptions);
    console.log('Welcome email sent to:', userEmail, 'MessageId:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Failed to send welcome email:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  isEmailConfigured,
  sendWelcomeEmail,
};
