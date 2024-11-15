import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs/promises';
import winston from 'winston';

// Setup Logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'grocery-bot.log' })
    ],
});

// Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// Initialize the bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Grocery categories
const categories = {
    'proteins': '🥩',
    'healthy_carbs': '🍚',
    'vitamins': '💊',
    'healthy_fats': '🥑',
    'meal_prep': '🍱',
    'fruits': '🍎',
    'vegetables': '🥦',
    'other': '📦',
    'ikea': '🇸🇪',

};

// Load shopping list
async function loadShoppingList() {
    try {
        const data = await fs.readFile('shopping-list.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error(`Error loading shopping list: ${error.message}`);
        return { items: [] };
    }
}

// Save shopping list
async function saveShoppingList(items) {
    try {
        await fs.writeFile('shopping-list.json', JSON.stringify({ items }, null, 2));
    } catch (error) {
        logger.error(`Error saving shopping list: ${error.message}`);
    }
}

// Utility function to safely send messages
async function safeSendMessage(chatId, message, options = {}) {
    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        logger.error(`Failed to send message: ${error.message}`);

        // If it's a parsing error, try sending without markdown
        if (error.response?.body?.error_code === 400 &&
            error.response?.body?.description?.includes("can't parse entities")) {
            try {
                // Strip markdown and try again without parse_mode
                const strippedMessage = message.replace(/[*_`\[]/g, '');
                return await bot.sendMessage(chatId, strippedMessage);
            } catch (retryError) {
                logger.error(`Failed to send stripped message: ${retryError.message}`);
                // Send a simple error message as last resort
                return await bot.sendMessage(chatId, "Sorry, there was an error displaying this message.");
            }
        }

        // For other errors, send a generic error message
        try {
            return await bot.sendMessage(chatId, "Sorry, there was an error processing your request.");
        } catch (finalError) {
            logger.error(`Failed to send error message: ${finalError.message}`);
        }
    }
}

// Handle /start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
🛒 *Welcome to GroceryBot!*

Available commands:
/list - View and check items in shopping list
/add - Add items to list
/remove - Remove items
/clear - Clear entire list
/categories - View categories

Use /help for more information.
`;

    await safeSendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Global error handler for bot
bot.on('error', (error) => {
    logger.error(`Bot error: ${error.code} - ${error.message}`);
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
🛒 *GroceryBot Help*

Commands:
/list - View and check items in your shopping list
/add - Add items to your list
/remove - Remove items from your list
/clear - Clear your entire list
/categories - View available categories

*Adding Items:*
Use /add and follow the prompts to add items.
Format: item name, quantity, category

*Categories:*
${Object.entries(categories).map(([cat, emoji]) => `${emoji} ${cat}`).join('\n')}
`;

    await safeSendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle /categories command
bot.onText(/\/categories/, async (msg) => {
    const chatId = msg.chat.id;
    const categoriesList = Object.entries(categories)
        .map(([cat, emoji]) => `${emoji} *${cat}*`)
        .join('\n');

    await safeSendMessage(chatId, `*Available Categories:*\n\n${categoriesList}`, { parse_mode: 'Markdown' });
});

// Handle /list command
bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const shoppingList = await loadShoppingList();

    if (shoppingList.items.length === 0) {
        await safeSendMessage(chatId, '📝 Your shopping list is empty.');
        return;
    }

    const message = '🛒 Shopping List\nTap items to check/uncheck them:\n';

    // Create keyboard with all items
    const keyboard = {
        inline_keyboard: shoppingList.items.map(item => ([{
            text: `${item.checked ? '✅' : '⬜'} ${categories[item.category]} ${item.name} (${item.quantity})`,
            callback_data: `toggle_${shoppingList.items.indexOf(item)}`
        }]))
    };

    try {
        await bot.sendMessage(chatId, message, {
            reply_markup: keyboard
        });
    } catch (error) {
        logger.error(`Error displaying shopping list: ${error.message}`);
        await safeSendMessage(chatId, 'Sorry, there was an error displaying your shopping list. Please try again.');
    }
});

// Conversation state for adding items
const addItemStates = new Map();

// Handle /add command
bot.onText(/\/add/, async (msg) => {
    const chatId = msg.chat.id;
    addItemStates.set(chatId, { state: 'awaiting_name' });

    const keyboard = {
        inline_keyboard: Object.entries(categories).map(([cat, emoji]) => ([
            { text: `${emoji} ${cat}`, callback_data: `category_${cat}` }
        ]))
    };

    await bot.sendMessage(
        chatId,
        'Select a category for the new item:',
        { reply_markup: keyboard }
    );
});

// Handle category selection
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('category_')) {
        const category = data.replace('category_', '');
        addItemStates.set(chatId, {
            state: 'awaiting_name',
            category: category
        });
        await bot.sendMessage(chatId, 'Enter the item name:');
        await bot.answerCallbackQuery(query.id);
    }
});

// Handle item name and quantity
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = addItemStates.get(chatId);

    if (!state || msg.text?.startsWith('/')) return;

    if (state.state === 'awaiting_name' && state.category) {
        state.name = msg.text;
        state.state = 'awaiting_quantity';
        addItemStates.set(chatId, state);
        await bot.sendMessage(chatId, 'Enter the quantity:');
    }
    else if (state.state === 'awaiting_quantity') {
        const shoppingList = await loadShoppingList();
        shoppingList.items.push({
            name: state.name,
            quantity: msg.text,
            category: state.category,
            checked: false
        });
        await saveShoppingList(shoppingList.items);

        await bot.sendMessage(
            chatId,
            `✅ Added to your list:\n${categories[state.category]} ${state.name} (${msg.text})`
        );
        addItemStates.delete(chatId);
    }
});

// Handle /remove command
bot.onText(/\/remove/, async (msg) => {
    const chatId = msg.chat.id;
    const shoppingList = await loadShoppingList();

    if (shoppingList.items.length === 0) {
        await bot.sendMessage(chatId, '📝 Your shopping list is empty.');
        return;
    }

    const keyboard = {
        inline_keyboard: shoppingList.items.map(item => ([{
            text: `${categories[item.category]} ${item.name} (${item.quantity})`,
            callback_data: `remove_${shoppingList.items.indexOf(item)}`
        }]))
    };

    await bot.sendMessage(
        chatId,
        'Select an item to remove:',
        { reply_markup: keyboard }
    );
});

// Handle item actions (remove and toggle)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data.startsWith('remove_')) {
        const index = parseInt(data.replace('remove_', ''));
        const shoppingList = await loadShoppingList();

        // Validate index exists
        if (index < 0 || index >= shoppingList.items.length) {
            await bot.answerCallbackQuery(query.id, {
                text: 'This item no longer exists in the list',
                show_alert: true
            });
            return;
        }

        const removedItem = shoppingList.items[index];
        shoppingList.items.splice(index, 1);
        await saveShoppingList(shoppingList.items);

        await bot.sendMessage(
            chatId,
            `✅ Removed from your list:\n${categories[removedItem.category]} ${removedItem.name}`
        );
        await bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('toggle_')) {
        const index = parseInt(data.replace('toggle_', ''));
        const shoppingList = await loadShoppingList();

        // Validate index exists
        if (index < 0 || index >= shoppingList.items.length) {
            await bot.answerCallbackQuery(query.id, {
                text: 'This item no longer exists in the list',
                show_alert: true
            });
            return;
        }

        shoppingList.items[index].checked = !shoppingList.items[index].checked;
        await saveShoppingList(shoppingList.items);

        // Create updated keyboard
        const keyboard = {
            inline_keyboard: shoppingList.items.map(item => ([{
                text: `${item.checked ? '✅' : '⬜'} ${categories[item.category]} ${item.name} (${item.quantity})`,
                callback_data: `toggle_${shoppingList.items.indexOf(item)}`
            }]))
        };

        // Update the message with new keyboard
        await bot.editMessageText(
            '✏️ *Shopping List Checkoff*\nTap items to check/uncheck them:\n',
            {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            }
        );

        // Show brief feedback in the notification
        await bot.answerCallbackQuery(query.id, {
            text: `${shoppingList.items[index].name} ${shoppingList.items[index].checked ? 'checked ✅' : 'unchecked ⬜'}`,
        });
    }
});

// Handle /clear command
bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    await saveShoppingList([]);
    await bot.sendMessage(chatId, '🗑️ Your shopping list has been cleared.');
});

// Error handling
bot.on('polling_error', (error) => {
    logger.error(`Polling error: ${error.code} - ${error.message}`);
});

process.on('SIGINT', () => {
    logger.info('Received SIGINT. Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM. Shutting down...');
    process.exit(0);
});
