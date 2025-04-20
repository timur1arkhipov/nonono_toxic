const TelegramBot = require("node-telegram-bot-api")
const fs = require("fs")
const cron = require("node-cron")
const http = require("http")

const PORT = 3009

const token = process.env.TELEGRAM_BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

const DB_FILE = "ratings.json"
let db = {
  users: {},
  weeklyActivity: {},
  weeklyRatingChanges: {},
  reactions: {}
}

if (fs.existsSync(DB_FILE)) {
  console.log(`Загрузка базы данных из ${DB_FILE}`)
  db = JSON.parse(fs.readFileSync(DB_FILE))
  
  if (!db.reactions) {
    db.reactions = {}
  }
}

function saveDB() {
  console.log("Сохранение базы данных")
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

function initUser(userId, username) {
  if (username === "nononotoxic_bot") {
    console.log(`Пропущено: ${username} является ботом и исключен из рейтинга`)
    return false
  }

  if (!db.users[userId]) {
    console.log(`Новый пользователь: ${username || `User${userId}`}`)
    db.users[userId] = {
      id: userId,
      username: username || `User${userId}`,
      rating: 1000,
    }
  }

  if (!db.weeklyActivity[userId]) {
    db.weeklyActivity[userId] = false
  }

  if (!db.weeklyRatingChanges[userId]) {
    db.weeklyRatingChanges[userId] = 0
  }
  
  return true
}

function updateRating(userId, change) {
  const oldRating = db.users[userId].rating
  db.users[userId].rating += change
  db.weeklyRatingChanges[userId] += change

  if (db.users[userId].rating < 0) {
    db.users[userId].rating = 0
  }

  console.log(`Рейтинг пользователя ${db.users[userId].username} изменился: ${oldRating} -> ${db.users[userId].rating} (${change > 0 ? '+' : ''}${change})`)
  saveDB()
}

bot.on("message", (msg) => {
  const userId = msg.from.id
  const username = msg.from.username || msg.from.first_name
  const chatId = msg.chat.id
  const messageText = msg.text || ""

  if (!initUser(userId, username)) {
    return
  }

  db.weeklyActivity[userId] = true
  
  if (msg.reply_to_message) {
    const originalMessageId = msg.reply_to_message.message_id
    const originalMessageAuthorId = msg.reply_to_message.from.id
    const originalMessageAuthorName = msg.reply_to_message.from.username || msg.reply_to_message.from.first_name
    
    if (userId === originalMessageAuthorId) {
      console.log(`Пропущено: ${username} ответил на собственное сообщение`)
      saveDB()
      return
    }
    
    if (originalMessageAuthorName === "nononotoxic_bot") {
      console.log(`Пропущено: оценка сообщения от бота ${originalMessageAuthorName}`)
      return
    }
    
    if (!initUser(originalMessageAuthorId, originalMessageAuthorName)) {
      return
    }
    
    const reactionKey = `${chatId}_${originalMessageId}`
    
    if (!db.reactions[reactionKey]) {
      db.reactions[reactionKey] = {}
    }
    
    if (db.reactions[reactionKey][userId]) {
      const prevReaction = db.reactions[reactionKey][userId]
      console.log(`Пропущено: ${username} уже реагировал на сообщение ${originalMessageAuthorName} (${prevReaction})`)
      return
    }
    
    if (messageText.trim().toLowerCase() === "w") {
      updateRating(originalMessageAuthorId, 25)
      console.log(`${username} оценил сообщение ${originalMessageAuthorName} как W. +25 очков!`)
      
      db.reactions[reactionKey][userId] = "w"
    } else if (messageText.trim().toLowerCase() === "f") {
      updateRating(originalMessageAuthorId, -25)
      console.log(`${username} оценил сообщение ${originalMessageAuthorName} как F. -25 очков!`)
      
      db.reactions[reactionKey][userId] = "f"
    }
  }
  
  console.log(`Сообщение от ${username} в чате ${chatId}`)
  saveDB()
})

function generateRatingsReport() {
  console.log("Формирование отчета о рейтингах")
  
  const sortedUsers = Object.values(db.users)
    .filter(user => user.username !== "nononotoxic_bot")
    .sort((a, b) => b.rating - a.rating)

  let report = "<b>📊 Еженедельный отчет рейтингов 📊</b>\n\n"
  report += "<b>Текущие рейтинги:</b>\n"

  sortedUsers.forEach((user, index) => {
    report += `${index + 1}. ${user.username}: ${user.rating} очков\n`
  })

  report += "\n<b>Изменения за неделю:</b>\n"

  const sortedByChanges = Object.entries(db.weeklyRatingChanges)
    .filter(([userId]) => {
      const username = db.users[userId]?.username;
      return username && username !== "nononotoxic_bot";
    })
    .map(([userId, change]) => ({
      userId,
      change,
      username: db.users[userId]?.username || `User${userId}`,
    }))
    .sort((a, b) => b.change - a.change)

  sortedByChanges.forEach((item, index) => {
    const changeSymbol = item.change > 0 ? "📈" : item.change < 0 ? "📉" : "➖"
    report += `${index + 1}. ${item.username}: ${changeSymbol} ${item.change} очков\n`
  })

  return report;
}

function applyInactivityPenalty() {
  console.log("Применение штрафов за неактивность")
  
  Object.keys(db.weeklyActivity).forEach((userId) => {
    if (!db.weeklyActivity[userId]) {
      console.log(`Пользователь ${db.users[userId]?.username} был неактивен на этой неделе. -125 очков!`)
      updateRating(userId, -125)
    }

    db.weeklyActivity[userId] = false
  })
}

function resetWeeklyChanges() {
  console.log("Сброс еженедельных изменений рейтинга")
  
  Object.keys(db.weeklyRatingChanges).forEach((userId) => {
    db.weeklyRatingChanges[userId] = 0
  })
  saveDB()
}

function cleanupOldReactions() {
  console.log("Очистка старых данных о реакциях")
  
  db.reactions = {}
  saveDB()
}

cron.schedule("0 17 * * 6", () => {
  console.log("Генерация еженедельного отчета...")

  applyInactivityPenalty()

  const report = generateRatingsReport()

  const activeChatIds = getActiveChatIds()

  console.log(`Отправка еженедельного отчета в ${activeChatIds.length} чатов`)
  activeChatIds.forEach((chatId) => {
    bot.sendMessage(chatId, report, { parse_mode: "HTML" })
  })

  resetWeeklyChanges()
  
  cleanupOldReactions()
})

function getActiveChatIds() {
  console.log("Запрос активных чатов (не реализовано)")
  return []
}

bot.onText(/\/ratings/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  console.log(`Пользователь ${msg.from.username || userId} запросил текущие рейтинги`)
  
  const sortedUsers = Object.values(db.users)
    .filter(user => user.username !== "nononotoxic_bot")
    .sort((a, b) => b.rating - a.rating)
  
  let report = `<b>📊 Еженедельный отчет рейтингов 📊</b>\n\n`
  report += `<b>Текущие рейтинги:</b>\n`
  
  sortedUsers.forEach((user, index) => {
    report += `${index + 1}. ${user.username}: ${user.rating} очков\n`
  })
  
  report += `\n<b>Изменения за неделю:</b>\n`
  
  const sortedByChanges = Object.entries(db.weeklyRatingChanges)
    .filter(([userId]) => {
      const username = db.users[userId]?.username;
      return username && username !== "nononotoxic_bot";
    })
    .map(([userId, change]) => ({
      userId,
      change,
      username: db.users[userId]?.username || `User${userId}`,
    }))
    .sort((a, b) => b.change - a.change)
  
  sortedByChanges.forEach((item, index) => {
    const changeSymbol = item.change > 0 ? "📈" : item.change < 0 ? "📉" : "➖"
    report += `${index + 1}. ${item.username}: ${changeSymbol} ${item.change} очков\n`
  })
  
  bot.sendMessage(chatId, report, { parse_mode: "HTML" })
})

bot.onText(/\/top(?:\s+(\d+))?/, (msg, match) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  const limit = parseInt(match[1]) || 10
  
  console.log(`Пользователь ${msg.from.username || userId} запросил топ-${limit} рейтингов`)
  
  const sortedUsers = Object.values(db.users)
    .filter(user => user.username !== "nononotoxic_bot")
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit)

  let report = `<b>📊 Топ-${limit} рейтингов 📊</b>\n\n`
  
  sortedUsers.forEach((user, index) => {
    report += `${index + 1}. ${user.username}: ${user.rating} очков\n`
  })

  bot.sendMessage(chatId, report, { parse_mode: "HTML" })
})

bot.onText(/\/myrating/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  const username = msg.from.username || msg.from.first_name
  
  console.log(`Пользователь ${username} запросил свой рейтинг`)
  
  initUser(userId, username)
  
  const sortedUsers = Object.values(db.users).sort((a, b) => b.rating - a.rating)
  const position = sortedUsers.findIndex(user => user.id === userId) + 1
  
  let report = `<b>📊 Ваш рейтинг 📊</b>\n\n`
  report += `${username}, ваш текущий рейтинг: <b>${db.users[userId].rating}</b> очков\n`
  report += `Вы на <b>${position}</b> месте из ${sortedUsers.length} пользователей\n`
  
  const weeklyChange = db.weeklyRatingChanges[userId]
  const changeSymbol = weeklyChange > 0 ? "📈" : weeklyChange < 0 ? "📉" : "➖"
  
  report += `\nИзменение за неделю: ${changeSymbol} ${weeklyChange} очков`
  
  bot.sendMessage(chatId, report, { parse_mode: "HTML" })
})

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  
  console.log(`Пользователь ${msg.from.username || userId} запросил помощь`)
  
  const helpText = `
<b>Помощь по боту рейтингов</b>

Этот бот отслеживает рейтинги пользователей на основе ответов на сообщения:
- Ответ "w": +25 очков автору сообщения
- Ответ "f": -25 очков автору сообщения

<b>Правила:</b>
- Каждый пользователь начинает с 1000 очков
- Ответы на собственные сообщения не учитываются
- Неактивные пользователи теряют 125 очков в неделю
- Рейтинг не может опуститься ниже 0

<b>Команды:</b>
/ratings - Показать текущие рейтинги всех
/top [N] - Показать топ N пользователей (по умолчанию 10)
/myrating - Показать ваш личный рейтинг
/help - Показать это сообщение с помощью

Еженедельные отчеты публикуются каждую субботу в 17:00.
`
  bot.sendMessage(chatId, helpText, { parse_mode: "HTML" })
})

const server = http.createServer((req, res) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/plain')
  res.end('Бот рейтинга активен')
})

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`)
})

console.log("Бот рейтинга запущен!")
