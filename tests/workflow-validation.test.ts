import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.join(__dirname, '../workflows');

describe('Workflow Validation', () => {
    const files = fs.readdirSync(workflowsDir).filter(file => file.endsWith('.json'));

    files.forEach(file => {
        test(`should validate JSON structure of ${file}`, () => {
            const workflowPath = path.join(workflowsDir, file);
            const workflowContent = fs.readFileSync(workflowPath, 'utf8');
            let workflow;
            try {
                workflow = JSON.parse(workflowContent);
            } catch (e) {
                throw new Error(`Invalid JSON in ${file}`);
            }

            expect(workflow).toHaveProperty('nodes');
            expect(Array.isArray(workflow.nodes)).toBe(true);
            expect(workflow).toHaveProperty('connections');
            expect(typeof workflow.connections).toBe('object');
        });
    });
});
