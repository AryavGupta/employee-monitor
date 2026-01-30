# Deployment Guide

## Production Deployment Checklist

### Pre-Deployment

- [ ] Change all default passwords
- [ ] Update JWT_SECRET in .env
- [ ] Configure production database
- [ ] Set up SSL/TLS certificates
- [ ] Configure CORS for production domains
- [ ] Set up backup strategy
- [ ] Configure monitoring and logging
- [ ] Test all features in staging environment

### Backend Deployment

#### Option 1: Traditional Server (VPS/Dedicated)

```bash
# 1. Install Node.js and PostgreSQL on server
sudo apt update
sudo apt install -y nodejs npm postgresql

# 2. Clone repository
git clone <your-repo>
cd employee-monitor

# 3. Install dependencies
npm install --production

# 4. Set up database
sudo -u postgres createdb employee_monitor
sudo -u postgres psql -d employee_monitor -f backend/database/schema.sql

# 5. Configure environment
cp .env.example .env
nano .env  # Edit with production values

# 6. Install PM2 for process management
npm install -g pm2

# 7. Start application
pm2 start backend/server.js --name employee-monitor-api
pm2 save
pm2 startup  # Follow instructions

# 8. Set up Nginx reverse proxy
sudo apt install nginx
```

**Nginx Configuration** (`/etc/nginx/sites-available/employee-monitor`):
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/employee-monitor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Option 2: Docker Deployment

**Dockerfile** (create in project root):
```dockerfile
FROM node:16-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "backend/server.js"]
```

**docker-compose.yml**:
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: employee_monitor
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./backend/database/schema.sql:/docker-entrypoint-initdb.d/schema.sql
    ports:
      - "5432:5432"

  backend:
    build: .
    depends_on:
      - postgres
    environment:
      DB_HOST: postgres
      DB_USER: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: employee_monitor
      JWT_SECRET: ${JWT_SECRET}
    ports:
      - "3000:3000"
    volumes:
      - ./uploads:/app/uploads

volumes:
  postgres_data:
```

Deploy:
```bash
docker-compose up -d
```

#### Option 3: Cloud Platforms

**Heroku:**
```bash
heroku create employee-monitor-api
heroku addons:create heroku-postgresql:hobby-dev
heroku config:set JWT_SECRET=your-secret-key
git push heroku main
```

**AWS Elastic Beanstalk:**
```bash
eb init
eb create employee-monitor-env
eb deploy
```

### Admin Dashboard Deployment

#### Static Hosting (Netlify, Vercel, AWS S3)

```bash
cd admin-dashboard

# Build for production
npm run build

# Deploy to Netlify
npm install -g netlify-cli
netlify deploy --prod --dir=build

# Or deploy to Vercel
npm install -g vercel
vercel --prod

# Or upload to AWS S3
aws s3 sync build/ s3://your-bucket-name --delete
```

#### Nginx Static Hosting

```bash
# Build
cd admin-dashboard
npm run build

# Copy to web root
sudo cp -r build/* /var/www/html/

# Configure Nginx
sudo nano /etc/nginx/sites-available/dashboard
```

**Nginx Configuration**:
```nginx
server {
    listen 80;
    server_name dashboard.your-domain.com;
    root /var/www/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Desktop App Distribution

#### Windows Build

```bash
# Install dependencies
npm install --save-dev electron-builder

# Build for Windows
npm run build:desktop -- --win --x64

# Output: dist/Employee Monitor Setup.exe
```

#### macOS Build

```bash
# Build for macOS
npm run build:desktop -- --mac

# Output: dist/Employee Monitor.dmg
```

#### Auto-Update Setup (Optional)

Use electron-updater for automatic updates:

```bash
npm install electron-updater
```

Configure in `package.json`:
```json
{
  "build": {
    "appId": "com.company.employee-monitor",
    "publish": {
      "provider": "github",
      "owner": "your-username",
      "repo": "employee-monitor"
    }
  }
}
```

### SSL/TLS Configuration

#### Let's Encrypt (Free SSL)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
sudo certbot renew --dry-run  # Test renewal
```

### Monitoring & Logging

#### PM2 Monitoring

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7

# View logs
pm2 logs
pm2 monit
```

#### Application Logging

Install Winston:
```bash
npm install winston
```

Add to server.js:
```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
```

### Backup Strategy

#### Database Backup Script

Create `backup.sh`:
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"
pg_dump employee_monitor > $BACKUP_DIR/backup_$DATE.sql
find $BACKUP_DIR -type f -mtime +7 -delete  # Keep 7 days
```

Add to crontab:
```bash
crontab -e
# Add: 0 2 * * * /path/to/backup.sh
```

### Performance Optimization

1. **Enable Gzip Compression** (Nginx):
```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript;
```

2. **Database Optimization**:
```sql
VACUUM ANALYZE;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_custom ON table_name(column);
```

3. **Redis Caching** (Optional):
```bash
npm install redis
```

### Security Hardening

1. **Firewall Configuration**:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

2. **Rate Limiting** (Express):
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

app.use(limiter);
```

3. **Security Headers**:
```javascript
const helmet = require('helmet');
app.use(helmet());
```

### Environment Variables (Production)

Ensure these are set securely:
```env
NODE_ENV=production
JWT_SECRET=<strong-random-string>
DB_PASSWORD=<strong-password>
API_URL=https://api.your-domain.com
REACT_APP_API_URL=https://api.your-domain.com
```

### Health Checks

Add to backend:
```javascript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});
```

### Post-Deployment

- [ ] Test all endpoints
- [ ] Verify desktop app connects to production API
- [ ] Test dashboard login and screenshot viewing
- [ ] Monitor logs for errors
- [ ] Set up alerts for downtime
- [ ] Document any issues
- [ ] Train administrators on system usage

### Maintenance

#### Regular Tasks:
- Weekly: Check logs for errors
- Monthly: Review and clean old screenshots
- Monthly: Update dependencies
- Quarterly: Review security settings
- Quarterly: Optimize database

#### Update Process:
```bash
# Pull latest code
git pull origin main

# Install dependencies
npm install

# Restart services
pm2 restart employee-monitor-api

# Clear cache if needed
pm2 flush
```

---

For questions or issues, refer to the main README.md or contact support.
