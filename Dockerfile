FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3040

USER node
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3040/api/health || exit 1

CMD ["node", "server.js"]
