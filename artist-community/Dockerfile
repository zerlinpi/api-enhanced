FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY artist-community/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY artist-community/server.js artist-community/db.js artist-community/mail.js artist-community/official-metrics.js ./
COPY artist-community/index.html artist-community/admin.html artist-community/schema.sql ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
