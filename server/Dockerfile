FROM node:22-alpine
WORKDIR /app
COPY server.js .
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
