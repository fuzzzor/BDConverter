# Use a lightweight Node.js base image
FROM node:20-bullseye-slim

# Enable non-free repositories for RAR support
RUN sed -i 's/main/main contrib non-free/g' /etc/apt/sources.list

# Install poppler-utils for PDF conversion and archiving tools (7z, tar, rar)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    p7zip-full \
    rar \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /app

# Copy npm configuration files
COPY package*.json ./

# Install dependencies (Express, Multer, Adm-Zip)
RUN npm install

# Copy the rest of the source code
COPY . .

# Remove unused Windows and Electron files
RUN rm -rf bin main.js preload.js

# Create uploads directory for Multer
RUN mkdir -p uploads

# Expose web port
EXPOSE 3111

# Server startup command
CMD ["node", "server.js"]
