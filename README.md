# Toddle – Full-Stack React Native App

A cross-platform **Todo** application built with **Expo (React Native)** for the frontend (iOS, Android, Web) and **Express.js** for the backend API.

---

## 📁 Project Structure

```
toddle/
├── app/                    # Expo React Native frontend
│   ├── App.js              # Root component
│   ├── app.json            # Expo configuration
│   ├── package.json
│   └── src/
│       ├── components/     # Reusable UI components
│       ├── constants/      # Theme, colors, spacing
│       ├── context/        # Auth context & state management
│       ├── navigation/     # React Navigation setup
│       ├── screens/        # App screens
│       └── services/       # API client
├── server/                 # Express.js backend API
│   ├── server.js           # Express app entry point
│   ├── package.json
│   ├── .env                # Environment variables
│   ├── config/             # Database configuration
│   ├── middleware/          # Auth & error handling
│   └── routes/             # API route handlers
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and **npm**
- **Expo CLI**: `npm install -g expo-cli` (optional — `npx expo` works too)
- For iOS: macOS with Xcode installed
- For Android: Android Studio with an emulator

### 1. Start the Backend

```bash
cd server
npm install
npm run dev        # Starts on http://localhost:3001
```

The server uses **SQLite** (via better-sqlite3) so no external database setup is needed.

### 2. Start the Frontend

```bash
cd app
npm install
npx expo start
```

Then press:
- **`i`** — Open in iOS Simulator
- **`a`** — Open in Android Emulator
- **`w`** — Open in Web Browser

---

## 🔐 Authentication

| Endpoint              | Method | Description          |
|-----------------------|--------|----------------------|
| `/api/auth/register`  | POST   | Create new account   |
| `/api/auth/login`     | POST   | Login & get JWT      |
| `/api/auth/me`        | GET    | Get current user     |
| `/api/auth/profile`   | PUT    | Update profile       |
| `/api/auth/password`  | PUT    | Change password      |

### Auth Flow
1. User registers or logs in
2. Server returns a **JWT token**
3. Token is stored in **AsyncStorage** on the device
4. All subsequent API calls include `Authorization: Bearer <token>`
5. On app restart, saved token is validated against the server

---

## 📋 Todos API

| Endpoint             | Method | Description          |
|----------------------|--------|----------------------|
| `/api/todos`         | GET    | List todos (paginated, filterable) |
| `/api/todos/stats`   | GET    | Get todo statistics  |
| `/api/todos/:id`     | GET    | Get single todo      |
| `/api/todos`         | POST   | Create todo          |
| `/api/todos/:id`     | PUT    | Update todo          |
| `/api/todos/:id`     | DELETE | Delete todo          |

---

## 🛠 Tech Stack

### Frontend
- **Expo SDK 52** (React Native)
- **React Navigation 7** — Stack + Bottom Tab navigation
- **AsyncStorage** — Persistent token & user storage
- **@expo/vector-icons** — Ionicons icon set

### Backend
- **Express.js 4** — API server
- **better-sqlite3** — Zero-config embedded database
- **jsonwebtoken** — JWT authentication
- **bcryptjs** — Password hashing
- **express-validator** — Request validation
- **helmet** — Security headers
- **cors** — Cross-origin support
- **morgan** — Request logging

---

## ⚙️ Environment Variables

### Server (`server/.env`)

| Variable       | Default                                    | Description              |
|----------------|--------------------------------------------|--------------------------|
| `PORT`         | `3001`                                     | Server port              |
| `JWT_SECRET`   | `your-super-secret-jwt-key-...`            | JWT signing secret       |
| `JWT_EXPIRES_IN` | `7d`                                     | Token expiration         |
| `NODE_ENV`     | `development`                              | Environment mode         |

> ⚠️ **Change `JWT_SECRET`** to a strong random string before deploying!

---

## 📱 Platform Notes

### Android Emulator
The API URL automatically uses `10.0.2.2` to reach the host machine's localhost.

### Physical Device
Update the API URL in `app/src/services/api.js` to your machine's **local IP** (e.g., `192.168.1.x`).

### Web
Works out of the box on `localhost`.

---

## 📄 License

MIT
