# Use an up-to-date, fully supported Node.js base image (Debian Bookworm, Node 22 LTS)
FROM node:22-bookworm-slim

# Enable non-free repositories for RAR support (Bookworm uses deb822 sources by default,
# so we fall back to a classic sources.list to keep apt behavior predictable/updatable)
RUN echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list \
    && echo "deb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware" >> /etc/apt/sources.list \
    && echo "deb http://deb.debian.org/debian-security bookworm-security main contrib non-free non-free-firmware" >> /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources

# Install poppler-utils and 7zip via apt
RUN apt-get update && apt-get install -y \
    poppler-utils \
    p7zip-full \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install RAR 6.24 from RARLAB (pinned — RAR 7.x dropped -ma4/RAR4 support)
RUN wget -q https://www.rarlab.com/rar/rarlinux-x64-624.tar.gz -O /tmp/rar.tar.gz \
    && tar -xzf /tmp/rar.tar.gz -C /tmp \
    && cp /tmp/rar/rar /usr/local/bin/rar \
    && chmod +x /usr/local/bin/rar \
    && rm -rf /tmp/rar /tmp/rar.tar.gz

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
