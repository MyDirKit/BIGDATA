FROM node:slim
LABEL maintainer="Sangenendt, 5016743"

# Set node environment, either development or production
ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV

# Install dependencies
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm install --no-optional && npm cache clean --force

# Install app
COPY *.js /app/
RUN mkdir /app/views/
COPY views/* /app/views/

# Export app port and set entrypoint at startup
EXPOSE 3000
ENTRYPOINT ["node", "index.js"]
CMD [""]
