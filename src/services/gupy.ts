import { Job, SeniorityLevel, WorkplaceType, GupyRawJob, GupySearchDiagnostics } from '../types';
import { classifyGeo } from './geoClassifier';

export interface GupyFetchOptions {
  query?: string;
  location?: string;
  limit?: number;
  daysOld?: number;
}

export interface GupyFetchResult {
  ok: boolean;
  httpStatus: number;
  jobs: Job[];
  rawCount: number;
  diagnostics: GupySearchDiagnostics;
  error?: string;
}

function cleanText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Infer WorkplaceType using Gupy structured fields with text fallback.
 */
export function inferGupyWorkplaceType(
  rawWorkplace?: string,
  isRemote?: boolean,
  title?: string,
  description?: string,
  location?: string
): WorkplaceType {
  const combined = `${rawWorkplace || ''} ${title || ''} ${description || ''} ${location || ''}`.toLowerCase();

  if (isRemote === true || combined.includes('remoto') || combined.includes('remote') || combined.includes('100% remoto') || combined.includes('teletrabalho')) {
    return 'Remoto';
  }
  if (combined.includes('híbrido') || combined.includes('hibrido') || combined.includes('hybrid')) {
    return 'Híbrido';
  }
  return 'Presencial';
}

/**
 * Infer SeniorityLevel from vacancy type, title, and description.
 */
export function inferGupySeniority(
  rawType?: string,
  title?: string,
  description?: string
): SeniorityLevel {
  const combined = `${rawType || ''} ${title || ''} ${description || ''}`.toLowerCase();

  if (combined.includes('estágio') || combined.includes('estagio') || combined.includes('intern') || combined.includes('trainee')) {
    return 'Estágio';
  }
  if (combined.includes('júnior') || combined.includes('junior') || combined.includes('jr')) {
    return 'Júnior';
  }
  if (combined.includes('especialista') || combined.includes('specialist') || combined.includes('staff') || combined.includes('principal')) {
    return 'Especialista';
  }
  if (combined.includes('liderança') || combined.includes('tech lead') || combined.includes('coordenador') || combined.includes('gerente') || combined.includes('head') || combined.includes('diretor')) {
    return 'Liderança';
  }
  if (combined.includes('sênior') || combined.includes('senior') || combined.includes('sr')) {
    return 'Sênior';
  }
  return 'Pleno';
}

/**
 * Format Gupy location into clean, human-readable Brazilian standard.
 */
export function formatGupyLocation(
  city?: string,
  state?: string,
  country?: string,
  isRemoteWork?: boolean,
  workplaceType?: string
): string {
  if (isRemoteWork || workplaceType?.toLowerCase().includes('remote') || workplaceType?.toLowerCase().includes('remoto')) {
    return city && state ? `${city}, ${state} (Remoto)` : 'Brasil (100% Remoto)';
  }
  if (city && state) {
    return `${city}, ${state}`;
  }
  if (city) return city;
  if (state) return `${state}, Brasil`;
  return 'Brasil';
}

/**
 * Extract key requirements from structured skills and text description.
 */
export function extractGupyRequirements(
  title: string,
  description: string,
  skills?: string[]
): string[] {
  const reqs = new Set<string>();

  // Add explicit skills if provided by Gupy
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (typeof skill === 'string' && skill.trim().length > 1) {
        reqs.add(skill.trim());
      }
    }
  }

  // Common keywords to search in description
  const techKeywords = [
    'React', 'TypeScript', 'Node.js', 'Python', 'Java', 'SQL', 'PostgreSQL', 'AWS',
    'Docker', 'Kubernetes', 'Customer Success', 'CRM', 'Salesforce', 'HubSpot',
    'Excel', 'Power BI', 'Figma', 'Product Management', 'Scrum', 'Agile'
  ];

  const descLower = description.toLowerCase();
  for (const kw of techKeywords) {
    if (descLower.includes(kw.toLowerCase()) && reqs.size < 8) {
      reqs.add(kw);
    }
  }

  if (reqs.size === 0) {
    reqs.add('Vaga cadastrada na plataforma oficial Gupy');
    reqs.add('Requisitos completos no link da vaga');
  }

  return Array.from(reqs).slice(0, 8);
}

/**
 * Normalizes a raw Gupy job into the application's canonical Job model.
 */
export function normalizeGupyJob(raw: GupyRawJob): Job {
  const title = cleanText(raw.name || 'Vaga Sem Título');
  const company = cleanText(raw.careerPageName || 'Empresa na Gupy');
  const description = cleanText(raw.description || 'Descrição detalhada disponível na página oficial de candidatura da Gupy.');
  const location = formatGupyLocation(raw.city, raw.state, raw.country, raw.isRemoteWork, raw.workplaceType);
  const workplaceType = inferGupyWorkplaceType(raw.workplaceType, raw.isRemoteWork, title, description, location);
  const seniority = inferGupySeniority(raw.type, title, description);
  const requirements = extractGupyRequirements(title, description, raw.skills);

  let pubDateStr = raw.publishedAt || raw.createdAt || new Date().toISOString().split('T')[0];
  if (pubDateStr.includes('T')) {
    pubDateStr = pubDateStr.split('T')[0];
  }

  // Official public candidate application page URL
  const jobUrl = raw.jobUrl || raw.careerPageUrl || `https://portal.gupy.io/job-search/term=${encodeURIComponent(title)}`;
  const geoCategory = classifyGeo(location, description);

  return {
    id: `gupy-${raw.id}`,
    title,
    company,
    location,
    workplaceType,
    seniority,
    description: description.substring(0, 1500),
    requirements,
    url: jobUrl,
    publishedAt: pubDateStr,
    source: 'gupy',
    sources: ['gupy'],
    discovery_source: 'Gupy (portal.gupy.io)',
    companyLogo: raw.careerPageLogo,
    geoCategory,
  };
}

/**
 * Fetches jobs from the Gupy source via backend proxy.
 */
export async function fetchGupyJobs(options: GupyFetchOptions = {}): Promise<GupyFetchResult> {
  const startTime = Date.now();
  const query = options.query?.trim() || '';
  const location = options.location?.trim() || '';
  const limit = options.limit || 50;
  const daysOld = options.daysOld || 30;

  try {
    const response = await fetch('/api/gupy/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, location, limit, daysOld }),
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        jobs: [],
        rawCount: 0,
        diagnostics: {
          status: 'ERROR',
          publicDiscovery: 'AVAILABLE',
          blockedCount: 0,
          duplicatesRemoved: 0,
          finalGupyResults: 0,
          durationMs,
          cacheStatus: 'LIVE',
          adapterVersion: 'GUPY-BRAZIL-V1',
          expansionStage: 'BRAZIL-SOURCES-V1',
          error: `HTTP ${response.status}`,
        },
        error: `Erro ao consultar Gupy (HTTP ${response.status})`,
      };
    }

    const data = await response.json();
    const rawList: GupyRawJob[] = Array.isArray(data.results) ? data.results : [];
    const normalizedJobs: Job[] = rawList.map(normalizeGupyJob);

    return {
      ok: true,
      httpStatus: 200,
      jobs: normalizedJobs,
      rawCount: rawList.length,
      diagnostics: {
        status: normalizedJobs.length > 0 ? 'ACTIVE' : 'EMPTY',
        publicDiscovery: 'AVAILABLE',
        blockedCount: 0,
        duplicatesRemoved: 0,
        finalGupyResults: normalizedJobs.length,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'GUPY-BRAZIL-V1',
        expansionStage: 'BRAZIL-SOURCES-V1',
        error: null,
      },
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    return {
      ok: false,
      httpStatus: 500,
      jobs: [],
      rawCount: 0,
      diagnostics: {
        status: 'ERROR',
        publicDiscovery: 'AVAILABLE',
        blockedCount: 0,
        duplicatesRemoved: 0,
        finalGupyResults: 0,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'GUPY-BRAZIL-V1',
        expansionStage: 'BRAZIL-SOURCES-V1',
        error: err.message || 'Exceção de rede ao conectar com Gupy',
      },
      error: err.message || 'Falha ao conectar com o serviço Gupy',
    };
  }
}
