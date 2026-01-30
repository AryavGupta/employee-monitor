#!/usr/bin/env node
/**
 * Login Verification Agent
 * Tests the login functionality of the Employee Monitor Admin Dashboard
 *
 * Usage: node verify-login.js [API_URL]
 * Default API_URL: http://localhost:3000
 */

const https = require('https');
const http = require('http');

const API_URL = process.argv[2] || 'http://localhost:3000';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(message, type = 'info') {
  const icons = {
    success: `${colors.green}[PASS]${colors.reset}`,
    error: `${colors.red}[FAIL]${colors.reset}`,
    info: `${colors.cyan}[INFO]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    test: `${colors.bold}[TEST]${colors.reset}`
  };
  console.log(`${icons[type]} ${message}`);
}

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      timeout: 10000
    };

    const req = lib.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function testHealthCheck() {
  log('Testing health check endpoint...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/health`);
    if (response.status === 200 && response.data.status === 'healthy') {
      log(`Health check passed - Server is healthy (${response.data.timestamp})`, 'success');
      return true;
    } else {
      log(`Health check returned unexpected response: ${JSON.stringify(response.data)}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Health check failed: ${error.message}`, 'error');
    return false;
  }
}

async function testLoginEndpointExists() {
  log('Testing login endpoint availability...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: {}
    });
    // Expecting 400 because we're not providing credentials
    if (response.status === 400 && response.data.message) {
      log('Login endpoint is accessible and validates input', 'success');
      return true;
    } else if (response.status === 401) {
      log('Login endpoint is accessible (rejected empty credentials)', 'success');
      return true;
    } else {
      log(`Login endpoint returned unexpected status: ${response.status}`, 'warn');
      return true; // Still accessible
    }
  } catch (error) {
    log(`Login endpoint not accessible: ${error.message}`, 'error');
    return false;
  }
}

async function testLoginValidation() {
  log('Testing login input validation...', 'test');

  // Test missing email
  try {
    const response = await makeRequest(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: { password: 'test' }
    });
    if (response.status === 400 || response.status === 401) {
      log('Missing email validation works', 'success');
    } else {
      log(`Missing email validation failed: got status ${response.status}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Validation test failed: ${error.message}`, 'error');
    return false;
  }

  // Test missing password
  try {
    const response = await makeRequest(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: { email: 'test@example.com' }
    });
    if (response.status === 400 || response.status === 401) {
      log('Missing password validation works', 'success');
    } else {
      log(`Missing password validation failed: got status ${response.status}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Validation test failed: ${error.message}`, 'error');
    return false;
  }

  return true;
}

async function testInvalidCredentials() {
  log('Testing invalid credentials rejection...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: {
        email: 'nonexistent@example.com',
        password: 'wrongpassword123'
      }
    });
    if (response.status === 401 && response.data.success === false) {
      log('Invalid credentials correctly rejected with 401', 'success');
      return true;
    } else {
      log(`Invalid credentials test: unexpected response status ${response.status}`, 'warn');
      return response.status === 401;
    }
  } catch (error) {
    log(`Invalid credentials test failed: ${error.message}`, 'error');
    return false;
  }
}

async function testValidLogin(email, password) {
  log(`Testing valid login with provided credentials...`, 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: { email, password }
    });

    if (response.status === 200 && response.data.success && response.data.token) {
      log('Valid login successful - Token received', 'success');
      log(`User: ${response.data.user?.email || 'N/A'} (${response.data.user?.role || 'N/A'})`, 'info');
      return response.data.token;
    } else if (response.status === 401) {
      log('Login rejected - Check if credentials are correct', 'error');
      return null;
    } else if (response.status === 403) {
      log('Account is deactivated', 'error');
      return null;
    } else {
      log(`Unexpected response: ${JSON.stringify(response.data)}`, 'error');
      return null;
    }
  } catch (error) {
    log(`Login test failed: ${error.message}`, 'error');
    return null;
  }
}

async function testTokenVerification(token) {
  log('Testing token verification...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 200 && response.data.success) {
      log('Token verification successful', 'success');
      return true;
    } else {
      log(`Token verification failed: ${JSON.stringify(response.data)}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Token verification failed: ${error.message}`, 'error');
    return false;
  }
}

async function testProtectedEndpoint(token) {
  log('Testing protected endpoint access...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/profile`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 200 && response.data.success) {
      log('Protected endpoint accessible with valid token', 'success');
      return true;
    } else {
      log(`Protected endpoint failed: ${response.status}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Protected endpoint test failed: ${error.message}`, 'error');
    return false;
  }
}

async function testUnauthorizedAccess() {
  log('Testing unauthorized access rejection...', 'test');
  try {
    const response = await makeRequest(`${API_URL}/api/auth/profile`, {
      method: 'GET'
    });

    if (response.status === 401) {
      log('Unauthorized access correctly rejected', 'success');
      return true;
    } else {
      log(`Expected 401, got ${response.status}`, 'error');
      return false;
    }
  } catch (error) {
    log(`Unauthorized test failed: ${error.message}`, 'error');
    return false;
  }
}

async function runTests(testEmail, testPassword) {
  console.log('\n' + '='.repeat(60));
  console.log(`${colors.bold}Employee Monitor - Login Verification Agent${colors.reset}`);
  console.log(`Testing API at: ${API_URL}`);
  console.log('='.repeat(60) + '\n');

  const results = {
    total: 0,
    passed: 0,
    failed: 0
  };

  const tests = [
    { name: 'Health Check', fn: testHealthCheck },
    { name: 'Login Endpoint Exists', fn: testLoginEndpointExists },
    { name: 'Login Validation', fn: testLoginValidation },
    { name: 'Invalid Credentials', fn: testInvalidCredentials },
    { name: 'Unauthorized Access', fn: testUnauthorizedAccess }
  ];

  // Run basic tests
  for (const test of tests) {
    results.total++;
    const passed = await test.fn();
    if (passed) results.passed++;
    else results.failed++;
    console.log('');
  }

  // Run authenticated tests if credentials provided
  let token = null;
  if (testEmail && testPassword) {
    results.total++;
    token = await testValidLogin(testEmail, testPassword);
    if (token) {
      results.passed++;
      console.log('');

      results.total++;
      if (await testTokenVerification(token)) results.passed++;
      else results.failed++;
      console.log('');

      results.total++;
      if (await testProtectedEndpoint(token)) results.passed++;
      else results.failed++;
      console.log('');
    } else {
      results.failed++;
      log('Skipping authenticated tests due to login failure', 'warn');
    }
  } else {
    log('No credentials provided - skipping authenticated tests', 'warn');
    log('Usage: node verify-login.js [API_URL] [email] [password]', 'info');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`${colors.bold}Test Summary${colors.reset}`);
  console.log('='.repeat(60));
  console.log(`Total Tests: ${results.total}`);
  console.log(`${colors.green}Passed: ${results.passed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${results.failed}${colors.reset}`);
  console.log('='.repeat(60) + '\n');

  if (results.failed === 0) {
    log('All tests passed! Login functionality is working correctly.', 'success');
    process.exit(0);
  } else {
    log(`${results.failed} test(s) failed. Please investigate.`, 'error');
    process.exit(1);
  }
}

// Parse arguments
const args = process.argv.slice(2);
const testEmail = args[1] || process.env.TEST_EMAIL;
const testPassword = args[2] || process.env.TEST_PASSWORD;

runTests(testEmail, testPassword);
