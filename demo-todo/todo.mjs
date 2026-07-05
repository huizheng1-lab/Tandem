#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, 'todo.json');

/**
 * Load todos from the JSON file, or return an empty array if file doesn't exist
 */
function loadTodos() {
  if (!existsSync(DATA_FILE)) {
    return [];
  }
  try {
    const data = readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

/**
 * Save todos to the JSON file
 */
function saveTodos(todos) {
  writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2), 'utf8');
}

/**
 * Add a new todo item
 */
function addTodo(text) {
  const todos = loadTodos();
  const newId = todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1;
  todos.push({
    id: newId,
    text: text,
    done: false,
    createdAt: new Date().toISOString()
  });
  saveTodos(todos);
  console.log(`Added todo: "${text}" (ID: ${newId})`);
}

/**
 * List all todo items
 */
function listTodos() {
  const todos = loadTodos();
  if (todos.length === 0) {
    console.log('No todos found.');
    return;
  }
  todos.forEach(todo => {
    const status = todo.done ? '[x]' : '[ ]';
    console.log(`${status} ${todo.id}. ${todo.text}`);
  });
}

/**
 * Mark a todo item as done by ID
 */
function doneTodo(id) {
  const todos = loadTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) {
    console.log(`Error: Todo with ID ${id} not found.`);
    process.exit(1);
  }
  todo.done = true;
  saveTodos(todos);
  console.log(`Completed: "${todo.text}"`);
}

/**
 * Main CLI entry point
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'add':
      if (args.length < 2) {
        console.log('Usage: todo.mjs add "<text>"');
        process.exit(1);
      }
      addTodo(args.slice(1).join(' '));
      break;

    case 'list':
      listTodos();
      break;

    case 'done':
      if (args.length < 2) {
        console.log('Usage: todo.mjs done <id>');
        process.exit(1);
      }
      const id = parseInt(args[1], 10);
      if (isNaN(id)) {
        console.log('Error: ID must be a number.');
        process.exit(1);
      }
      doneTodo(id);
      break;

    default:
      console.log('Usage: todo.mjs <add|list|done> [args]');
      console.log('  add "<text>"   - Add a new todo');
      console.log('  list           - List all todos');
      console.log('  done <id>      - Mark a todo as complete');
      process.exit(1);
  }
}

main();
