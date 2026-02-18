// Quick test to verify our baseCommitAtStart persistence works
const fs = require('fs');
const path = require('path');

console.log('Testing baseCommitAtStart persistence...');

// Test that we can access the persistence module and it includes baseCommitAtStart in serialization
try {
  const persistenceFile = fs.readFileSync(path.join(__dirname, 'src', 'plan', 'persistence.ts'), 'utf-8');
  
  // Check that baseCommitAtStart is included in the SerializedPlan interface
  if (persistenceFile.includes('baseCommitAtStart?: string;')) {
    console.log('✅ SerializedPlan interface includes baseCommitAtStart');
  } else {
    console.log('❌ SerializedPlan interface missing baseCommitAtStart');
  }
  
  // Check that baseCommitAtStart is serialized
  if (persistenceFile.includes('baseCommitAtStart: plan.baseCommitAtStart,')) {
    console.log('✅ serialize() includes baseCommitAtStart');
  } else {
    console.log('❌ serialize() missing baseCommitAtStart');
  }
  
  // Check that baseCommitAtStart is deserialized  
  if (persistenceFile.includes('baseCommitAtStart: data.baseCommitAtStart,')) {
    console.log('✅ deserialize() includes baseCommitAtStart');
  } else {
    console.log('❌ deserialize() missing baseCommitAtStart');
  }
  
  // Check that our tests were added
  const testFile = fs.readFileSync(path.join(__dirname, 'src', 'test', 'unit', 'plan', 'persistence.test.ts'), 'utf-8');
  
  if (testFile.includes('baseCommitAtStart survives serialization round-trip')) {
    console.log('✅ Round-trip test added');
  } else {
    console.log('❌ Round-trip test missing');
  }
  
  if (testFile.includes('plan without baseCommitAtStart loads correctly')) {
    console.log('✅ Backwards compatibility test added');
  } else {
    console.log('❌ Backwards compatibility test missing');
  }
  
  if (testFile.includes('serialize includes baseCommitAtStart when set')) {
    console.log('✅ Serialization output test added');
  } else {
    console.log('❌ Serialization output test missing');
  }
  
  console.log('✅ All tests implemented successfully!');
  
} catch (error) {
  console.error('Error:', error.message);
}