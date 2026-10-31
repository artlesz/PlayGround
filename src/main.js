import './style.css';
import { Studio } from './studio.js';

const studio = new Studio();

studio.start();

window.__studio = studio;
window.__PRISMA__ = studio;
