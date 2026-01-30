# Employee Monitoring System - Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Prerequisites
- Node.js v16+ installed
- PostgreSQL installed and running
- 10 minutes of your time

### Quick Setup (Windows/Mac/Linux)

#### 1. Clone and Navigate
```bash
cd employee-monitor
```

#### 2. Install Dependencies
```bash
npm install
```

#### 3. Database Setup
```bash
# Create database
createdb employee_monitor

# Load schema (creates default admin user)
psql -d employee_monitor -f backend/database/schema.sql
```

#### 4. Configure Environment
```bash
# Copy example config
cp .env.example .env

# Edit .env with your database credentials
# Most defaults work fine for local development
```

#### 5. Start Backend
```bash
# In terminal 1
npm run start:backend
```
Backend runs on `http://localhost:3000`

#### 6. Start Admin Dashboard
```bash
# In terminal 2
cd admin-dashboard
npm install
npm start
```
Dashboard opens at `http://localhost:3001`

#### 7. Start Desktop App
```bash
# In terminal 3 (from root directory)
npm run start:desktop
```

### Login Credentials
**Admin Dashboard & Desktop App:**
- Email: `admin@company.com`
- Password: `Admin@123`

### Test the System

1. **Desktop App**: Login and watch it capture screenshots every minute
2. **Admin Dashboard**: Login and view the screenshots in real-time
3. **Filters**: Try filtering by date, employee, or flagged status

### What's Next?

- Read the full [README.md](README.md) for detailed documentation
- Check [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment
- Review [ARCHITECTURE.md](ARCHITECTURE.md) for technical details

### Need Help?

**Common Issues:**

1. **Port 3000 already in use**
   - Change PORT in .env file
   - Update API_URL in desktop-app/main.js

2. **Database connection failed**
   - Verify PostgreSQL is running: `pg_isready`
   - Check credentials in .env

3. **Desktop app won't capture**
   - Ensure backend is running first
   - Check network connectivity
   - Look for errors in desktop app console

### Project Structure Quick Reference
```
employee-monitor/
├── desktop-app/          # Electron desktop application
├── backend/              # Express API server
├── admin-dashboard/      # React admin interface
├── README.md            # Full documentation
├── DEPLOYMENT.md        # Production deployment guide
└── ARCHITECTURE.md      # Technical architecture
```

### Development Workflow

**Adding a New Employee:**
```bash
# Use the admin dashboard to create users
# Or use the API directly
curl -X POST http://localhost:3000/api/auth/register \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "employee@company.com",
    "password": "SecurePass123",
    "fullName": "John Doe",
    "role": "employee"
  }'
```

**Viewing Logs:**
```bash
# Backend logs
tail -f backend/logs/combined.log

# Desktop app logs
# Check Electron console (View → Toggle Developer Tools)
```

### Tips for Production

1. Change all default passwords immediately
2. Use environment variables for secrets
3. Set up SSL/TLS certificates
4. Configure regular database backups
5. Monitor system resources
6. Set up log rotation

---

That's it! You now have a fully functional employee monitoring system.

For more details, explore the documentation files included in this project.
