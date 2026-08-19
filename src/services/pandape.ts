import { Job, SeniorityLevel, WorkplaceType, PandapeRawJob, PandapeSearchDiagnostics } from '../types';
import { classifyGeo } from './geoClassifier';

export interface PandapeFetchOptions {
  query?: string;
  location?: string;
  limit?: number;
  daysOld?: number;
}

export interface PandapeFetchResult {
  ok: boolean;
  httpStatus: number;
  jobs: Job[];
  rawCount: number;
  diagnostics: PandapeSearchDiagnostics;
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
 * Infer WorkplaceType for Pandapé vacancies.
 */
export function inferPandapeWorkplaceType(
  isRemote?: boolean,
  title?: string,
  description?: string,
  contractType?: string
): WorkplaceType {
  const combined = `${title || ''} ${description || ''} ${contractType || ''}`.toLowerCase();

  if (isRemote === true || combined.includes('remoto') || combined.includes('remote') || combined.includes('100% remoto') || combined.includes('home office')) {
    return 'Remoto';
  }
  if (combined.includes('híbrido') || combined.includes('hibrido') || combined.includes('hybrid')) {
    return 'Híbrido';
  }
  return 'Presencial';
}

/**
 * Infer SeniorityLevel for Pandapé vacancies.
 */
export function inferPandapeSeniority(
  title?: string,
  description?: string
): SeniorityLevel {
  const combined = `${title || ''} ${description || ''}`.toLowerCase();

  if (combined.includes('estágio') || combined.includes('estagio') || combined.includes('intern') || combined.includes('trainee')) {
    return 'Estágio';
  }
  if (combined.includes('júnior') || combined.includes('junior') || combined.includes('jr')) {
    return 'Júnior';
  }
  if (combined.includes('especialista') || combined.includes('specialist') || combined.includes('staff')) {
    return 'Especialista';
  }
  if (combined.includes('liderança') || combined.includes('tech lead') || combined.includes('coordenador') || combined.includes('gerente') || combined.includes('diretor')) {
    return 'Liderança';
  }
  if (combined.includes('sênior') || combined.includes('senior') || combined.includes('sr')) {
    return 'Sênior';
  }
  return 'Pleno';
}

/**
 * Format Pandapé location string.
 */
export function formatPandapeLocation(
  city?: string,
  state?: string,
  isRemote?: boolean
): string {
  if (isRemote) {
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
 * Extract requirements from description.
 */
export function extractPandapeRequirements(
  title: string,
  description: string
): string[] {
  const reqs = new Set<string>();

  const techKeywords = [
    'React', 'TypeScript', 'Node.js', 'Python', 'Java', 'SQL', 'PostgreSQL', 'AWS',
    'Customer Success', 'CRM', 'Salesforce', 'HubSpot', 'Excel', 'Power BI', 'Atendimento ao Cliente'
  ];

  const descLower = description.toLowerCase();
  for (const kw of techKeywords) {
    if (descLower.includes(kw.toLowerCase()) && reqs.size < 6) {
      reqs.add(kw);
    }
  }

  if (reqs.size === 0) {
    reqs.add('Vaga cadastrada na plataforma oficial Pandapé');
    reqs.add('Requisitos disponíveis no link da vaga');
  }

  return Array.from(reqs).slice(0, 6);
}

/**
 * Normalizes a raw Pandapé job into the canonical Job model.
 */
export function normalizePandapeJob(raw: PandapeRawJob): Job {
  const title = cleanText(raw.title || 'Vaga Sem Título');
  const company = cleanText(raw.companyName || 'Empresa via Pandapé');
  const description = cleanText(raw.description || 'Descrição detalhada disponível na página oficial de candidatura Pandapé.');
  const location = formatPandapeLocation(raw.city, raw.state, raw.isRemote);
  const workplaceType = inferPandapeWorkplaceType(raw.isRemote, title, description, raw.contractType);
  const seniority = inferPandapeSeniority(title, description);
  const requirements = extractPandapeRequirements(title, description);

  let pubDateStr = raw.publishedDate || new Date().toISOString().split('T')[0];
  if (pubDateStr.includes('T')) {
    pubDateStr = pubDateStr.split('T')[0];
  }

  const jobUrl = raw.url || `https://pandape.infojobs.com.br/vaga/${raw.id}`;
  const geoCategory = classifyGeo(location, description);

  return {
    id: `pandape-${raw.id}`,
    title,
    company,
    location,
    workplaceType,
    seniority,
    description: description.substring(0, 1500),
    requirements,
    url: jobUrl,
    publishedAt: pubDateStr,
    salaryRange: raw.salary || undefined,
    source: 'pandape',
    sources: ['pandape'],
    discovery_source: 'Pandapé (Infojobs)',
    geoCategory,
  };
}

/**
 * Fetches jobs from the Pandapé source via backend proxy.
 */
export async function fetchPandapeJobs(options: PandapeFetchOptions = {}): Promise<PandapeFetchResult> {
  const startTime = Date.now();
  const query = options.query?.trim() || '';
  const location = options.location?.trim() || '';
  const limit = options.limit || 50;
  const daysOld = options.daysOld || 30;

  try {
    const response = await fetch('/api/pandape/search', {
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
          finalPandapeResults: 0,
          tenantsChecked: 0,
          tenantsSuccessful: 0,
          durationMs,
          cacheStatus: 'LIVE',
          adapterVersion: 'PANDAPE-BRAZIL-V1',
          expansionStage: 'BRAZIL-SOURCES-V1',
          error: `HTTP ${response.status}`,
        },
        error: `Erro ao consultar Pandapé (HTTP ${response.status})`,
      };
    }

    const data = await response.json();
    const rawList: PandapeRawJob[] = Array.isArray(data.results) ? data.results : [];
    const normalizedJobs: Job[] = rawList.map(normalizePandapeJob);

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
        finalPandapeResults: normalizedJobs.length,
        tenantsChecked: data.tenantsChecked || 1,
        tenantsSuccessful: data.tenantsSuccessful || 1,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'PANDAPE-BRAZIL-V1',
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
        finalPandapeResults: 0,
        tenantsChecked: 0,
        tenantsSuccessful: 0,
        durationMs,
        cacheStatus: 'LIVE',
        adapterVersion: 'PANDAPE-BRAZIL-V1',
        expansionStage: 'BRAZIL-SOURCES-V1',
        error: err.message || 'Exceção de rede ao conectar com Pandapé',
      },
      error: err.message || 'Falha ao conectar com o serviço Pandapé',
    };
  }
}

/**
 * Fetches enriched detail for a specific Pandapé job.
 */
export async function fetchPandapeJobDetail(tenantKey?: string, jobId?: string): Promise<{ ok: boolean; job?: Job; error?: string }> {
  try {
    const res = await fetch(`/api/pandape/detail?tenantKey=${encodeURIComponent(tenantKey || '')}&jobId=${encodeURIComponent(jobId || '')}`);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.ok && data.job) {
      return { ok: true, job: normalizePandapeJob(data.job) };
    }
    return { ok: false, error: data.error || 'Vaga não encontrada' };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Erro ao carregar detalhes Pandapé' };
  }
}
