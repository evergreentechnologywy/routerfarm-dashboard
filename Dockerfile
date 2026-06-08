FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV ROUTERFARM_HOSTED=true
EXPOSE 7781
CMD ["node", "server.js"]
