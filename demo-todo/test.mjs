import { spawn } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TODO_CLI = join(__dirname, 'todo.mjs');
const DATA_FILE = join(__dirname, 'todo.json');

let testsRun = 0;
let testsPassed = 0;

/**
 * Execute a todo CLI command and return a promise with the result
 */
function execTodo(...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [TODO_CLI, ...args], {
      cwd: __dirname
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Simple assertion helper
 */
function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Clean up the todo.json file before tests
 */
function cleanup() {
  if (existsSync(DATA_FILE)) {
    unlinkSync(DATA_FILE);
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('\n=== Todo CLI Tests ===\n');

  // Clean up before tests
  cleanup();

  // Test 1: Add a todo item
  console.log('Test: Add todo');
  let result = await execTodo('add', 'buy milk');
  assert(result.code === 0, 'Add command should exit with code 0');
  assert(result.stdout.includes('buy milk'), 'Add output should contain the todo text');
  assert(result.stdout.includes('ID: 1'), 'Add output should contain the ID');

  // Test 2: Add another todo item
  console.log('\nTest: Add second todo');
  result = await execTodo('add', 'buy bread');
  assert(result.code === 0, 'Second add should exit with code 0');
  assert(result.stdout.includes('ID: 2'), 'Second add should have ID 2');

  // Test 3: List todos
  console.log('\nTest: List todos');
  result = await execTodo('list');
  assert(result.code === 0, 'List command should exit with code 0');
  assert(result.stdout.includes('[ ] 1. buy milk'), 'List should show first todo as unchecked');
  assert(result.stdout.includes('[ ] 2. buy bread'), 'List should show second todo as unchecked');

  // Test 4: Mark first todo as done
  console.log('\nTest: Mark todo as done');
  result = await execTodo('done', '1');
  assert(result.code === 0, 'Done command should exit with code 0');
  assert(result.stdout.includes('Completed'), 'Done output should show completion message');
  assert(result.stdout.includes('buy milk'), 'Done output should show todo text');

  // Test 5: List todos after marking done
  console.log('\nTest: List todos after marking done');
  result = await execTodo('list');
  assert(result.code === 0, 'List should still exit with code 0');
  assert(result.stdout.includes('[x] 1. buy milk'), 'First todo should be marked as done');
  assert(result.stdout.includes('[ ] 2. buy bread'), 'Second todo should still be unchecked');

  // Test 6: Mark non-existent todo
  console.log('\nTest: Mark non-existent todo');
  result = await execTodo('done', '999');
  assert(result.code === 1, 'Done with non-existent ID should exit with code 1');
  assert(result.stdout.includes('not found'), 'Should show not found error');

  // Test 7: Invalid command
  console.log('\nTest: Invalid command');
  result = await execTodo('invalid');
  assert(result.code === 1, 'Invalid command should exit with code 1');
  assert(result.stdout.includes('Usage'), 'Should show usage information');

  // Test 8: Add without text
  console.log('\nTest: Add without text');
  result = await execTodo('add');
  assert(result.code === 1, 'Add without text should exit with code 1');
  assert(result.stdout.includes('Usage'), 'Should show usage information');

  // Test 9: Done without ID
  console.log('\nTest: Done without ID');
  result = await execTodo('done');
  assert(result.code === 1, 'Done without ID should exit with code 1');
  assert(result.stdout.includes('Usage'), 'Should show usage information');

  // Cleanup
  cleanup();

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Tests run: ${testsRun}`);
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsRun - testsPassed}`);

  if (testsRun === testsPassed) {
    console.log('\n✓ All tests passed!\n');
    process.exit(0);
  } else {
    console.log('\n✗ Some tests failed!\n');
    process.exit(1);
  }
}

// Run tests and handle errors
runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
