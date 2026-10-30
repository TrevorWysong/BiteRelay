# The network's push relay (push/, MOBILE.md "Waking a closed app"): a small
# Node service with no dependencies beyond Node itself.
FROM node:24-slim
WORKDIR /app/push
COPY push/package.json push/package-lock.json ./
RUN npm ci
COPY push/ ./
ENV DB_PATH=/var/lib/relay-push/push.db
VOLUME /var/lib/relay-push
EXPOSE 8892
CMD ["npm", "start"]
