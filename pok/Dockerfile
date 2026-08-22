FROM node:22-alpine

WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run unprivileged — the image ships a "node" user.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
