import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.join(__dirname, '../workflows');

async function deployWorkflows() {
    try {
        const files = fs.readdirSync(workflowsDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const workflowPath = path.join(workflowsDir, file);
                const workflowContent = fs.readFileSync(workflowPath, 'utf8');
                const workflow = JSON.parse(workflowContent);
                console.log(`Deploying workflow: ${workflow.name}`);
                // Add n8n API logic here to update/create workflow
            }
        }
        console.log('All workflows processed.');
    } catch (error) {
        console.error('Error deploying workflows:', error);
        process.exit(1);
    }
}

deployWorkflows();
