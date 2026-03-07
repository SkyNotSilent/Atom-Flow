import express from "express";
import { createServer as createViteServer } from "vite";
import { MOCK_ARTICLES } from "./src/data/mock.js";
import { AtomCard, Article } from "./src/types.js";
import Parser from "rss-parser";

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

async function fetchRSSFeeds(): Promise<Article[]> {
  try {
    // Fetch from SSPAI (少数派) official RSS feed
    const feed = await parser.parseURL('https://sspai.com/feed');
    return feed.items.slice(0, 10).map((item, index) => {
      const content = item.content || item['content:encoded'] || item.contentSnippet || '';
      const excerpt = content.replace(/<[^>]+>/g, '').substring(0, 120) + '...';
      const topic = (item.categories && item.categories.length > 0) ? item.categories[0] : '科技资讯';
      
      // Format time (e.g., "10:30" or "03-05")
      let timeStr = '刚刚';
      if (item.pubDate) {
        const date = new Date(item.pubDate);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
          timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } else {
          timeStr = `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
        }
      }

      return {
        id: Date.now() + index,
        saved: false,
        source: '少数派',
        topic: topic,
        time: timeStr,
        title: item.title || '无标题',
        excerpt: excerpt,
        content: content,
        url: item.link,
        cards: [] // Initially empty, will be generated on save
      };
    });
  } catch (error) {
    console.error('Failed to fetch RSS, falling back to mock data:', error);
    return [...MOCK_ARTICLES];
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // In-memory database for prototype
  let articles: Article[] = [];
  let savedCards: AtomCard[] = [];

  // Load RSS feeds on startup
  console.log('Fetching RSS feeds...');
  articles = await fetchRSSFeeds();
  console.log(`Loaded ${articles.length} articles.`);

  // API Routes
  
  // Get all articles
  app.get("/api/articles", async (req, res) => {
    // Optional: Refresh feeds periodically or on request
    // if (articles.length === 0) articles = await fetchRSSFeeds();
    res.json(articles);
  });

  // Save an article (mark as saved and extract cards)
  app.post("/api/articles/:id/save", (req, res) => {
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    if (!article.saved) {
      article.saved = true;
      
      let cardsToSave = article.cards;
      
      // If no cards exist (e.g., from real RSS), generate some dummy cards for now
      // Later this will be replaced by the LLM
      if (!cardsToSave || cardsToSave.length === 0) {
        cardsToSave = [
          {
            type: "观点",
            content: `关于「${article.title}」的核心观点：${article.excerpt.substring(0, 40)}...`,
            tags: [article.topic, "自动提取"]
          },
          {
            type: "金句",
            content: article.excerpt.substring(0, 50) + "...",
            tags: ["摘录"]
          }
        ];
        article.cards = cardsToSave;
      }

      // Extract cards and add to savedCards
      const newCards: AtomCard[] = cardsToSave.map(c => ({
        ...c,
        id: Math.random().toString(36).substr(2, 9),
        articleTitle: article.title,
        articleId: article.id
      }));
      
      savedCards = [...newCards, ...savedCards];
    }

    res.json({ success: true, article });
  });

  // Fetch full content for an article
  app.get("/api/articles/:id/full", async (req, res) => {
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    try {
      if (article.url) {
        console.log(`Fetching full content for: ${article.url}`);
        const response = await fetch(`https://r.jina.ai/${article.url}`, {
          headers: {
            'X-Remove-Selector': '.comment-list, .comments, footer, nav, .related-posts, .article-related, .user-card, .author-info, .footnotes, #footnotes, .article-footnotes, .reference',
            'X-Return-Format': 'markdown',
          }
        });
        if (response.ok) {
          let markdown = await response.text();
          
          // --- Markdown Cleanup Heuristics ---
          
          // 1. Remove common noise patterns (e.g., small icon images, tracking pixels)
          // Look for images with specific keywords in URL or alt text that suggest they are noise
          markdown = markdown.replace(/!\[.*?\]\((.*?(?:icon|avatar|logo|tracker|pixel|qrcode|qr_code|wx_fmt|sponsor|ad).*?)\)/gi, '');
          
          // 2. Remove images that are likely too small to be content (often base64 icons or tiny SVGs)
          markdown = markdown.replace(/!\[.*?\]\(data:image\/(svg\+xml|png|jpeg);base64,.*?\)/gi, '');
          
          // 3. Remove "Read more", "Share", "Follow us" type links at the end of articles
          markdown = markdown.replace(/\[(?:阅读原文|分享至|关注我们|微信扫一扫|点赞|收藏|打赏)\]\(.*?\)/gi, '');
          
          // 4. Remove empty links or links with just an icon
          markdown = markdown.replace(/\[\s*(?:!\[.*?\]\(.*?\))?\s*\]\(.*?\)/g, '');
          
          // 5. Clean up multiple consecutive empty lines left behind by removals
          markdown = markdown.replace(/\n{3,}/g, '\n\n');
          
          // 6. Remove common boilerplate text at the end of articles
          markdown = markdown.replace(/(?:本文首发于|未经授权，不得转载|题图来自).*$/s, '');

          // 7. 删除少数派特有的头部导航噪音
          markdown = markdown.replace(/^[\s\S]*?(?=\*\*编者按|前言\n|##\s)/m, '');

          // 8. 删除评论区（从"全部评论"或"条评论"往后全删）
          markdown = markdown.replace(/\n全部评论[\s\S]*$/m, '');
          markdown = markdown.replace(/\n\d+\s*条评论[\s\S]*$/m, '');

          // 9. 删除文章底部的关联阅读、版权、扫码等
          markdown = markdown.replace(/\n(?:关联阅读|相关阅读|App 内打开|扫码分享|举报本文|© 本文著作权)[\s\S]*$/m, '');

          // 10. 删除作者信息块（头部重复出现的作者名/关注按钮）
          markdown = markdown.replace(/^.*?关注\n.*?\n.*?关注.*?\n/gm, '');

          // 11. 删除脚注后面的所有内容（少数派脚注后通常是噪音）
          // 警告：不能直接用 \n---\n[\s\S]*$ 因为作者可能在正文中使用分割线
          // 我们可以只删除明确的脚注块（如果 Jina 没有过滤掉的话）
          markdown = markdown.replace(/\n+\[\^1\]:[\s\S]*$/m, '');
          
          // 12. 删除文章中手动添加的参考资料/数据来源（例如："数据来源：https..."）
          // 警告：不要用 [\s\S]*$ 截断全文，只删除匹配的单行
          markdown = markdown.replace(/\n+(?:数据来源|参见|参考|来源|链接|注)[:：\s].*?https?:\/\/[^\n]+/g, '');

          // 13. 修复 Jina Reader 抓取时未闭合的代码块吞噬正文的问题
          // 如果代码块内部出现了连续的空行 + 长段中文，说明代码块提前结束了，强制插入闭合标记
          markdown = markdown.replace(/(```[a-zA-Z]*\n[\s\S]*?)(\n\n[\u4e00-\u9fa5]{10,})/g, (match, codepart, chineseText) => {
            const markers = codepart.match(/```/g);
            // 确保 codepart 里只有开头的那个 ```，没有其他的闭合标记
            if (markers && markers.length === 1) {
              return codepart + '\n```' + chineseText;
            }
            return match;
          });

          // 14. 兜底：如果整个文档的 ``` 数量是奇数，说明有未闭合的代码块，在末尾补上
          const codeBlockMarkers = (markdown.match(/```/g) || []).length;
          if (codeBlockMarkers % 2 !== 0) {
            markdown = markdown + '\n```';
          }

          // 15. 再压缩一次多余空行
          markdown = markdown.replace(/\n{3,}/g, '\n\n');

          article.markdownContent = markdown.trim();
        } else {
          throw new Error('Jina API returned an error');
        }
      } else {
        // Fallback for mock articles without URL
        await new Promise(resolve => setTimeout(resolve, 1500));
        article.markdownContent = `## 时代变化太快...\n\n(此为无链接文章的模拟内容)`;
      }
    } catch (error) {
      console.error('Failed to fetch from Jina:', error);
      // Fallback to original content if Jina fails
      article.markdownContent = article.content;
    }

    article.fullFetched = true;
    res.json({ success: true, article });
  });

  // Image proxy to bypass CSP and hotlink protection
  app.get("/api/image-proxy", async (req, res) => {
    const imageUrl = req.query.url as string;
    if (!imageUrl) {
      return res.status(400).send("Missing url parameter");
    }
    try {
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': new URL(imageUrl).origin
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } catch (error) {
      console.error('Image proxy error:', error);
      res.status(500).send("Failed to load image");
    }
  });

  // Get all saved cards
  app.get("/api/cards", (req, res) => {
    res.json(savedCards);
  });

  // Add a new manual card
  app.post("/api/cards", (req, res) => {
    const newCard: AtomCard = {
      ...req.body,
      id: Math.random().toString(36).substr(2, 9),
      articleTitle: req.body.articleTitle || "手动录入"
    };
    savedCards = [newCard, ...savedCards];
    res.json(newCard);
  });

  // Update a card
  app.put("/api/cards/:id", (req, res) => {
    const { id } = req.params;
    const index = savedCards.findIndex(c => c.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: "Card not found" });
    }

    savedCards[index] = { ...savedCards[index], ...req.body };
    res.json(savedCards[index]);
  });

  // Delete a card
  app.delete("/api/cards/:id", (req, res) => {
    const { id } = req.params;
    savedCards = savedCards.filter(c => c.id !== id);
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
