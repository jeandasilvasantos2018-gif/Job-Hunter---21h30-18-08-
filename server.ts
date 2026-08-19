import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Ensure all /api responses default to application/json
  app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  });

  // Helper function to query Adzuna safely with full diagnostics
  async function queryAdzuna(options: {
    query?: string;
    location?: string;
    daysOld?: number;
    country?: string;
    page?: number;
    resultsPerPage?: number;
  }) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    const credentialsStatus = {
      appId: appId && appId.trim() !== '' ? 'CONFIGURED' : 'MISSING',
      appKey: appKey && appKey.trim() !== '' ? 'CONFIGURED' : 'MISSING',
    };

    const clientEndpoint = '/api/adzuna/search';
    const backendHandler = 'server.ts:queryAdzuna';

    if (credentialsStatus.appId === 'MISSING' || credentialsStatus.appKey === 'MISSING') {
      return {
        ok: false,
        clientEndpoint,
        backendHandler,
        credentialsStatus,
        errorStage: 'BACKEND_PROXY' as const,
        statusCategory: 'MISSING_CREDENTIALS',
        httpStatus: 400,
        adzunaHttpStatus: null,
        statusText: 'Bad Request (Missing Credentials)',
        apiUrlSanitized: `https://api.adzuna.com/v1/api/jobs/${(options.country || 'br').toLowerCase().trim()}/search/${options.page || 1}?what=${encodeURIComponent(options.query || '')}&where=${encodeURIComponent(options.location || '')}`,
        countryCode: (options.country || 'br').toLowerCase().trim(),
        query: (options.query || '').trim() || '—',
        location: (options.location || '').trim() || '—',
        daysOld: options.daysOld || 30,
        page: options.page || 1,
        resultsPerPage: options.resultsPerPage || 50,
        adzunaCount: 0,
        resultsReceived: 0,
        adzunaError: 'Credenciais da Adzuna (ADZUNA_APP_ID / ADZUNA_APP_KEY) não foram configuradas nas variáveis de ambiente do servidor.',
        results: [],
      };
    }

    const countryCode = (options.country || 'br').toLowerCase().trim();
    const cleanQuery = (options.query || '').trim();
    const cleanLocation = (options.location || '').trim();
    const page = options.page || 1;
    const resultsPerPage = options.resultsPerPage || 50;
    const daysOld = options.daysOld || 30;

    // Build actual params with credentials
    const params = new URLSearchParams();
    params.append('app_id', appId.trim());
    params.append('app_key', appKey.trim());
    params.append('results_per_page', String(resultsPerPage));
    if (daysOld && !isNaN(Number(daysOld))) {
      params.append('max_days_old', String(daysOld));
    }
    if (cleanQuery) {
      params.append('what', cleanQuery);
    }
    if (cleanLocation) {
      const locLower = cleanLocation.toLowerCase();
      if (countryCode === 'br' && (locLower === 'brazil' || locLower === 'brasil')) {
        // Omit 'where' because endpoint /jobs/br/ already specifies country Brazil
      } else {
        params.append('where', cleanLocation);
      }
    }

    // Build sanitized params without credentials for UI/logging
    const sanitizedParams = new URLSearchParams();
    sanitizedParams.append('app_id', '[REDACTED]');
    sanitizedParams.append('app_key', '[REDACTED]');
    sanitizedParams.append('results_per_page', String(resultsPerPage));
    if (daysOld) sanitizedParams.append('max_days_old', String(daysOld));
    if (cleanQuery) sanitizedParams.append('what', cleanQuery);
    if (cleanLocation && !(countryCode === 'br' && (cleanLocation.toLowerCase() === 'brazil' || cleanLocation.toLowerCase() === 'brasil'))) {
      sanitizedParams.append('where', cleanLocation);
    }

    const adzunaUrl = `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}?${params.toString()}`;
    const sanitizedUrl = `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}?${sanitizedParams.toString()}`;

    try {
      const response = await fetch(adzunaUrl, {
        headers: {
          'Accept': 'application/json',
        },
      });

      let statusCategory = 'ADZUNA_ERROR';
      let data: any = null;
      let adzunaError: string | null = null;

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {}
        console.error(`Adzuna API Error (${response.status}):`, errorText);

        if (response.status === 401 || response.status === 403) {
          statusCategory = 'AUTH_ERROR';
          adzunaError = `Erro de Autenticação na Adzuna (HTTP ${response.status}): Verifique se ADZUNA_APP_ID e ADZUNA_APP_KEY são válidos.`;
        } else if (response.status === 429) {
          statusCategory = 'RATE_LIMIT';
          adzunaError = 'Limite de requisições atingido na API da Adzuna (Rate Limit 429). Tente novamente mais tarde.';
        } else if (response.status === 400) {
          statusCategory = 'BAD_REQUEST';
          adzunaError = `Parâmetros inválidos enviados para a Adzuna (HTTP ${response.status}).`;
        } else if (response.status === 404) {
          statusCategory = 'NOT_FOUND';
          adzunaError = `Endpoint ou mercado '${countryCode}' não encontrado na Adzuna (HTTP 404).`;
        } else {
          statusCategory = 'ADZUNA_ERROR';
          adzunaError = `Erro HTTP ${response.status} retornado pela Adzuna: ${response.statusText || 'Erro no provedor'}`;
        }

        return {
          ok: false,
          runtimeBackend: 'ADZUNA-BACKEND-V2',
          clientEndpoint,
          backendHandler,
          credentialsStatus,
          errorStage: 'ADZUNA_API' as const,
          statusCategory,
          httpStatus: 200, // proxy handled gracefully
          adzunaHttpStatus: response.status,
          statusText: response.statusText,
          apiUrlSanitized: sanitizedUrl,
          countryCode,
          query: cleanQuery || '—',
          location: cleanLocation || '—',
          daysOld,
          page,
          resultsPerPage,
          adzunaCount: 0,
          resultsReceived: 0,
          adzunaError,
          results: [],
        };
      }

      const rawText = await response.text();
      try {
        data = JSON.parse(rawText);
      } catch (parseErr: any) {
        return {
          ok: false,
          runtimeBackend: 'ADZUNA-BACKEND-V2',
          clientEndpoint,
          backendHandler,
          credentialsStatus,
          errorStage: 'RESPONSE_PARSE' as const,
          statusCategory: 'RESPONSE_PARSE_ERROR',
          httpStatus: 200,
          adzunaHttpStatus: response.status,
          statusText: 'Invalid JSON from Adzuna',
          apiUrlSanitized: sanitizedUrl,
          countryCode,
          query: cleanQuery || '—',
          location: cleanLocation || '—',
          daysOld,
          page,
          resultsPerPage,
          adzunaCount: 0,
          resultsReceived: 0,
          adzunaError: 'A Adzuna retornou uma resposta não-JSON ou corrompida.',
          results: [],
        };
      }

      const count = data.count || 0;
      const results = data.results || [];

      if (count > 0 && results.length > 0) {
        statusCategory = 'SUCCESS_WITH_RESULTS';
      } else {
        statusCategory = 'SUCCESS_EMPTY';
      }

      return {
        ok: true,
        runtimeBackend: 'ADZUNA-BACKEND-V2',
        clientEndpoint,
        backendHandler,
        credentialsStatus,
        errorStage: null,
        statusCategory,
        httpStatus: 200,
        adzunaHttpStatus: response.status,
        statusText: response.statusText,
        apiUrlSanitized: sanitizedUrl,
        countryCode,
        query: cleanQuery || '—',
        location: cleanLocation || '—',
        daysOld,
        page,
        resultsPerPage,
        adzunaCount: count,
        resultsReceived: results.length,
        adzunaError: null,
        results,
      };
    } catch (err: any) {
      console.error('Network/Server Exception querying Adzuna:', err);
      return {
        ok: false,
        runtimeBackend: 'ADZUNA-BACKEND-V2',
        clientEndpoint,
        backendHandler,
        credentialsStatus,
        errorStage: 'BACKEND_PROXY' as const,
        statusCategory: 'NETWORK_ERROR',
        httpStatus: 500,
        adzunaHttpStatus: null,
        statusText: 'Internal Server Error',
        apiUrlSanitized: sanitizedUrl,
        countryCode,
        query: cleanQuery || '—',
        location: cleanLocation || '—',
        daysOld,
        page,
        resultsPerPage,
        adzunaCount: 0,
        resultsReceived: 0,
        adzunaError: err.message || 'Exceção de rede ou servidor ao conectar com a Adzuna.',
        results: [],
      };
    }
  }

  // API Route: Secure Adzuna Proxy (supports POST, GET, with or without trailing slash)
  const handleAdzunaSearch = async (req: express.Request, res: express.Response) => {
    try {
      const query = (req.body?.query ?? req.query?.query) as string | undefined;
      const location = (req.body?.location ?? req.query?.location) as string | undefined;
      const daysOld = Number(req.body?.daysOld ?? req.query?.daysOld ?? req.body?.days ?? req.query?.days ?? 30);
      const country = (req.body?.country ?? req.query?.country ?? 'br') as string;
      const page = Number(req.body?.page ?? req.query?.page ?? 1);
      const resultsPerPage = Number(req.body?.resultsPerPage ?? req.query?.resultsPerPage ?? req.body?.limit ?? req.query?.limit ?? 50);

      const result = await queryAdzuna({ query, location, daysOld, country, page, resultsPerPage });
      return res.status(result.httpStatus || 200).json(result);
    } catch (routeErr: any) {
      return res.status(500).json({
        ok: false,
        runtimeBackend: 'ADZUNA-BACKEND-V2',
        clientEndpoint: '/api/adzuna/search',
        backendHandler: 'server.ts:queryAdzuna',
        errorStage: 'BACKEND_PROXY',
        statusCategory: 'SERVER_EXCEPTION',
        httpStatus: 500,
        adzunaHttpStatus: null,
        statusText: 'Internal Server Error',
        adzunaError: routeErr.message || 'Erro inesperado no servidor proxy Adzuna',
        results: [],
      });
    }
  };

  app.post('/api/adzuna/search', handleAdzunaSearch);
  app.post('/api/adzuna/search/', handleAdzunaSearch);
  app.get('/api/adzuna/search', handleAdzunaSearch);
  app.get('/api/adzuna/search/', handleAdzunaSearch);

  // ==========================================
  // REMOTAR SEARCH PROXY (remotar.com.br)
  // ==========================================
  async function queryRemotar(params: { query?: string; daysOld?: number; limit?: number }) {
    const query = (params.query || '').toLowerCase().trim();
    const daysOld = Number(params.daysOld || 30);
    const limit = Number(params.limit || 50);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    try {
      const response = await fetch('https://blog.remotar.com.br/feed/', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      });

      if (!response.ok) {
        return {
          ok: false,
          source: 'remotar',
          runtimeBackend: 'MULTI-SOURCE-V2',
          error: `Falha ao consultar feed do Remotar (HTTP ${response.status})`,
          jobsReceived: 0,
          results: [],
        };
      }

      const xml = await response.text();
      const items: any[] = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;

      while ((match = itemRegex.exec(xml)) !== null) {
        const itemContent = match[1];
        const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(itemContent);
        const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(itemContent);
        const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(itemContent);
        const descMatch = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(itemContent);
        const contentMatch = /<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i.exec(itemContent);

        const title = titleMatch ? titleMatch[1].replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&amp;/g, '&').trim() : 'Vaga Remota';
        const link = linkMatch ? linkMatch[1].trim() : 'https://remotar.com.br';
        const pubDateStr = pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString();
        const rawText = (contentMatch ? contentMatch[1] : (descMatch ? descMatch[1] : ''))
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const pubDate = new Date(pubDateStr);
        if (!isNaN(pubDate.getTime()) && pubDate < cutoff) {
          continue;
        }

        // Check query match if provided
        if (query) {
          const queryTerms = query.split(/\s+/).filter(Boolean);
          const matches = queryTerms.some(
            (term) => title.toLowerCase().includes(term) || rawText.toLowerCase().includes(term)
          );
          if (!matches) continue;
        }

        const isSenior = title.toLowerCase().includes('sênior') || title.toLowerCase().includes('senior') || title.toLowerCase().includes('sr');
        const isJunior = title.toLowerCase().includes('júnior') || title.toLowerCase().includes('junior') || title.toLowerCase().includes('jr');

        items.push({
          id: `remotar-${Buffer.from(link).toString('base64').substring(0, 16)}`,
          title,
          company: 'Remotar Curation',
          location: 'Brasil (100% Remoto)',
          workplaceType: 'Remoto',
          seniority: isSenior ? 'Sênior' : isJunior ? 'Júnior' : 'Pleno',
          description: rawText.substring(0, 1200) || `Oportunidades remotas selecionadas pela curadoria Remotar: ${title}`,
          requirements: ['100% Trabalho Remoto', 'Curadoria Remotar Brasil', 'Disponível para Residentes no Brasil'],
          url: link,
          publishedAt: pubDateStr,
          source: 'Remotar',
        });

        if (items.length >= limit) break;
      }

      return {
        ok: true,
        source: 'remotar',
        runtimeBackend: 'MULTI-SOURCE-V2',
        jobsReceived: items.length,
        results: items,
      };
    } catch (err: any) {
      return {
        ok: false,
        source: 'remotar',
        runtimeBackend: 'MULTI-SOURCE-V2',
        error: err.message || 'Erro ao conectar com Remotar',
        jobsReceived: 0,
        results: [],
      };
    }
  }

  const handleRemotarSearch = async (req: express.Request, res: express.Response) => {
    try {
      const query = (req.body?.query ?? req.query?.query) as string | undefined;
      const daysOld = Number(req.body?.daysOld ?? req.query?.daysOld ?? 30);
      const limit = Number(req.body?.limit ?? req.query?.limit ?? 50);

      const result = await queryRemotar({ query, daysOld, limit });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        source: 'remotar',
        runtimeBackend: 'MULTI-SOURCE-V2',
        error: err.message || 'Erro interno ao processar Remotar',
        jobsReceived: 0,
        results: [],
      });
    }
  };

  app.post('/api/remotar/search', handleRemotarSearch);
  app.get('/api/remotar/search', handleRemotarSearch);

  // ==========================================
  // VAGAS REMOTAS SEARCH (vagasremotas.com.br / GitHub BR Remote Jobs)
  // ==========================================
  async function queryVagasRemotas(params: { query?: string; daysOld?: number; limit?: number }) {
    const query = (params.query || '').toLowerCase().trim();
    const daysOld = Number(params.daysOld || 30);
    const limit = Number(params.limit || 50);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const repos = [
      'backend-br/vagas',
      'frontendbr/vagas',
      'react-brasil/vagas',
      'remotejobsbr/trabalho-remoto-vagas',
      'flutterbr/vagas',
      'qa-brasil/vagas',
      'datascience-br/vagas',
    ];

    const results: any[] = [];
    let reposChecked = 0;
    let reposSuccessful = 0;

    for (const repo of repos) {
      if (results.length >= limit) break;
      reposChecked++;
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=30`, {
          headers: {
            'User-Agent': 'JobHunterAI/1.0 (https://jobhunter.ai)',
            Accept: 'application/vnd.github.v3+json',
          },
        });

        if (!response.ok) continue;
        reposSuccessful++;
        const issues = await response.json();
        if (!Array.isArray(issues)) continue;

        for (const issue of issues) {
          if (issue.pull_request) continue; // skip PRs
          const createdAt = new Date(issue.created_at);
          if (!isNaN(createdAt.getTime()) && createdAt < cutoff) continue;

          const rawTitle: string = issue.title || '';
          const body: string = issue.body || '';
          const labels: string[] = (issue.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name || ''));

          // Determine workplace type
          let workplaceType: 'Remoto' | 'Híbrido' | 'Presencial' = 'Remoto';
          const labelStr = labels.join(' ').toLowerCase();
          const fullText = `${rawTitle} ${body} ${labelStr}`.toLowerCase();

          if (labelStr.includes('híbrido') || labelStr.includes('hibrido') || rawTitle.toLowerCase().includes('híbrido')) {
            workplaceType = 'Híbrido';
          } else if (labelStr.includes('presencial') || rawTitle.toLowerCase().includes('presencial')) {
            workplaceType = 'Presencial';
          } else {
            workplaceType = 'Remoto';
          }

          // Determine seniority
          let seniority: 'Estágio' | 'Júnior' | 'Pleno' | 'Sênior' | 'Especialista' | 'Liderança' = 'Pleno';
          if (
            labelStr.includes('sênior') ||
            labelStr.includes('senior') ||
            fullText.includes('sênior') ||
            fullText.includes('senior') ||
            fullText.includes('sr')
          ) {
            seniority = 'Sênior';
          } else if (
            labelStr.includes('júnior') ||
            labelStr.includes('junior') ||
            fullText.includes('júnior') ||
            fullText.includes('junior') ||
            fullText.includes('jr')
          ) {
            seniority = 'Júnior';
          } else if (labelStr.includes('estágio') || labelStr.includes('estagio') || fullText.includes('estagiário')) {
            seniority = 'Estágio';
          } else if (labelStr.includes('especialista') || fullText.includes('specialist') || fullText.includes('staff')) {
            seniority = 'Especialista';
          } else if (
            labelStr.includes('liderança') ||
            labelStr.includes('tech lead') ||
            fullText.includes('tech lead') ||
            fullText.includes('engineering manager')
          ) {
            seniority = 'Liderança';
          }

          // Extract clean title and company
          let cleanTitle = rawTitle.replace(/\[[^\]]+\]/g, '').trim();
          let company = 'Empresa Parceira Vagas Remotas';

          if (cleanTitle.includes(' na ')) {
            const parts = cleanTitle.split(' na ');
            cleanTitle = parts[0].trim();
            company = parts.slice(1).join(' na ').trim();
          } else if (cleanTitle.includes(' no ')) {
            const parts = cleanTitle.split(' no ');
            cleanTitle = parts[0].trim();
            company = parts.slice(1).join(' no ').trim();
          } else if (cleanTitle.includes(' @ ')) {
            const parts = cleanTitle.split(' @ ');
            cleanTitle = parts[0].trim();
            company = parts.slice(1).join(' @ ').trim();
          } else if (cleanTitle.includes(' - ')) {
            const parts = cleanTitle.split(' - ');
            cleanTitle = parts[0].trim();
            company = parts.slice(1).join(' - ').trim();
          }

          // Search for apply link inside body
          let applyUrl = issue.html_url;
          const urlMatch = body.match(/https?:\/\/[^\s\)\>\]]+/g);
          if (urlMatch) {
            const validApply = urlMatch.find(
              (u) =>
                !u.includes('github.com/users') &&
                !u.includes('avatars.githubusercontent') &&
                !u.includes('github.com/repos') &&
                (u.includes('forms') ||
                  u.includes('gupy') ||
                  u.includes('greenhouse') ||
                  u.includes('lever') ||
                  u.includes('vaga') ||
                  u.includes('jobs') ||
                  u.includes('career') ||
                  u.includes('apply'))
            );
            if (validApply) applyUrl = validApply;
          }

          // Filter by query if query provided
          if (query) {
            const queryTerms = query.split(/\s+/).filter(Boolean);
            const matches = queryTerms.some(
              (term) =>
                cleanTitle.toLowerCase().includes(term) ||
                body.toLowerCase().includes(term) ||
                company.toLowerCase().includes(term) ||
                labels.some((l) => l.toLowerCase().includes(term))
            );
            if (!matches) continue;
          }

          // Extract requirements from body
          const reqs: string[] = [];
          const bodyLines = body.split('\n').map((l) => l.trim()).filter(Boolean);
          for (const line of bodyLines) {
            if ((line.startsWith('-') || line.startsWith('*')) && line.length > 5 && line.length < 120) {
              reqs.push(line.replace(/^[-*]\s*/, ''));
              if (reqs.length >= 6) break;
            }
          }
          if (reqs.length === 0) {
            reqs.push('100% Trabalho Remoto Brasil', 'Regime CLT ou PJ');
          }

          results.push({
            id: `vagasremotas-gh-${issue.id}`,
            title: cleanTitle || rawTitle,
            company: company || 'Vagas Remotas BR',
            location: workplaceType === 'Remoto' ? 'Brasil (Remoto)' : 'Brasil (Híbrido/Remoto)',
            workplaceType,
            seniority,
            description: body.substring(0, 1500) || `Oportunidade na comunidade Vagas Remotas: ${rawTitle}`,
            requirements: reqs,
            url: applyUrl,
            publishedAt: issue.created_at,
            source: 'Vagas Remotas',
            discovery_source: `Vagas Remotas BR (${repo})`,
          });

          if (results.length >= limit) break;
        }
      } catch (err: any) {
        console.warn(`Erro ao consultar repo ${repo}:`, err.message);
      }
    }

    return {
      ok: true,
      source: 'vagasremotas',
      runtimeBackend: 'MULTI-SOURCE-V2',
      reposChecked,
      reposSuccessful,
      jobsReceived: results.length,
      results,
    };
  }

  const handleVagasRemotasSearch = async (req: express.Request, res: express.Response) => {
    try {
      const query = (req.body?.query ?? req.query?.query) as string | undefined;
      const daysOld = Number(req.body?.daysOld ?? req.query?.daysOld ?? 30);
      const limit = Number(req.body?.limit ?? req.query?.limit ?? 50);

      const result = await queryVagasRemotas({ query, daysOld, limit });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        source: 'vagasremotas',
        runtimeBackend: 'MULTI-SOURCE-V2',
        error: err.message || 'Erro interno ao processar Vagas Remotas',
        jobsReceived: 0,
        results: [],
      });
    }
  };

  app.post('/api/vagasremotas/search', handleVagasRemotasSearch);
  app.get('/api/vagasremotas/search', handleVagasRemotasSearch);

  // Minimal Test Diagnostic Endpoint
  app.get('/api/adzuna/test', async (req, res) => {
    try {
      const testResult = await queryAdzuna({
        query: 'customer',
        location: '', // Omit location
        daysOld: 30,
        resultsPerPage: 10,
        page: 1,
      });
      return res.json({
        testName: 'Minimal Diagnostic Test (Query: customer, Location: none, Days: 30, Limit: 10)',
        result: testResult,
      });
    } catch (testErr: any) {
      return res.status(500).json({
        ok: false,
        runtimeBackend: 'ADZUNA-BACKEND-V2',
        error: testErr.message || 'Erro no endpoint de teste Adzuna',
      });
    }
  });

  // Public Configuration Endpoint (Supabase Frontend Credentials Only)
  app.get('/api/config', (req, res) => {
    const supabaseUrl =
      process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      '';
    const supabasePublishableKey =
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      '';

    return res.json({
      supabaseUrl: supabaseUrl.trim(),
      supabasePublishableKey: supabasePublishableKey.trim(),
    });
  });

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      runtimeBackend: 'ADZUNA-BACKEND-V2',
      hasAdzunaCredentials: Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    });
  });

  // API 404 Fallback: guarantees any unmatched /api/* route returns JSON instead of falling through to HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      ok: false,
      runtimeBackend: 'ADZUNA-BACKEND-V2',
      error: `Endpoint '${req.originalUrl}' não encontrado na API.`,
      statusCategory: 'ROUTE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
