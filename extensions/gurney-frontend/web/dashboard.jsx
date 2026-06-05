/* global React, window */
const { useState } = React;

function DashboardTab() {
  return (
    <div className="dashboard-root">
      <div className="dash-header">
        <h2>Active Workflows</h2>
        <div className="dash-header-actions">
          <button className="dash-btn sub">All Workflows <window.Icon name="chevron-down" size={14} /></button>
          <div className="view-toggles">
            <button className="dash-icon-btn active"><window.Icon name="grid" size={16} /></button>
            <button className="dash-icon-btn"><window.Icon name="list" size={16} /></button>
          </div>
        </div>
      </div>

      <div className="dash-grid">
        {/* Card 1 */}
        <div className="dash-card">
          <div className="card-header">
            <div className="card-icon green"><window.Icon name="laptop" size={20} /></div>
            <div className="card-title">
              <h3>Marketplace Laptop Checker</h3>
              <span className="status-label green"><span className="dot green"></span> Running</span>
            </div>
          </div>
          <div className="progress-section">
            <div className="progress-labels">
              <span>Step 5 / 9</span>
              <span>56%</span>
            </div>
            <div className="progress-bar"><div className="progress-fill green" style={{ width: '56%' }}></div></div>
          </div>
          <div className="agent-tags">
            <span className="agent-tag green"><window.Icon name="spark" size={12} /> Research Agent</span>
            <span className="agent-tag blue"><window.Icon name="user" size={12} /> Review Agent</span>
          </div>
          <div className="card-actions">
            <button className="dash-btn">Open <window.Icon name="external-link" size={14} /></button>
            <button className="dash-btn sub"><window.Icon name="pause" size={14} /> Pause</button>
          </div>
        </div>

        {/* Card 2 */}
        <div className="dash-card yellow-border">
          <div className="card-header">
            <div className="card-icon blue"><window.Icon name="chip" size={20} /></div>
            <div className="card-title">
              <h3>ESP32 Voice Device Planner</h3>
              <span className="status-label yellow"><span className="dot yellow"></span> Waiting for approval</span>
            </div>
          </div>
          <div className="progress-section">
            <div className="progress-labels">
              <span>Step 4 / 8</span>
              <span>50%</span>
            </div>
            <div className="progress-bar"><div className="progress-fill blue" style={{ width: '50%' }}></div></div>
          </div>
          <div className="agent-tags">
            <span className="agent-tag purple"><window.Icon name="spark" size={12} /> Planner Agent</span>
            <span className="agent-tag blue"><window.Icon name="code" size={12} /> Code Agent</span>
          </div>
          <div className="card-actions single">
            <button className="dash-btn"><window.Icon name="shield" size={14} /> Review</button>
          </div>
        </div>

        {/* Card 3 */}
        <div className="dash-card">
          <div className="card-header">
            <div className="card-icon red"><window.Icon name="youtube" size={20} /></div>
            <div className="card-title">
              <h3>YouTube Research Workflow</h3>
              <span className="status-label green"><span className="dot green"></span> Running</span>
            </div>
          </div>
          <div className="task-list">
            <div className="task done"><window.Icon name="check-circle" size={16} /> Gather topic ideas</div>
            <div className="task done"><window.Icon name="check-circle" size={16} /> Search competitors</div>
            <div className="task done"><window.Icon name="check-circle" size={16} /> Summarize trends</div>
            <div className="task active"><window.Icon name="loader" size={16} className="spin" /> Choose best angles</div>
            <div className="task pending"><div className="circle"></div> Write script</div>
            <div className="task pending"><div className="circle"></div> Generate title options</div>
          </div>
          <div className="card-actions single" style={{ marginTop: 'auto' }}>
            <button className="dash-btn">Open <window.Icon name="external-link" size={14} /></button>
          </div>
        </div>
      </div>

      <div className="dash-section">
        <div className="section-header">
          <h3><window.Icon name="git-merge" size={16} className="green-text" /> Workflow: YouTube Research Workflow</h3>
          <button className="dash-btn sub text-sm">Expand <window.Icon name="chevron-down" size={14} /></button>
        </div>
        <div className="workflow-diagram">
          <div className="node">
            <window.Icon name="file-text" size={20} />
            <h4>Input Topic</h4>
            <p>"Best ESP32 Projects 2025"</p>
          </div>
          <div className="arrow green">→</div>
          <div className="node">
            <window.Icon name="spark" size={20} />
            <h4>Research Agent</h4>
            <p>Web search & data collection</p>
            <div className="status-check green"><window.Icon name="check" size={12} /></div>
          </div>
          <div className="arrow green">→</div>
          <div className="node">
            <window.Icon name="bar-chart" size={20} />
            <h4>Idea Ranker</h4>
            <p>Score & rank opportunities</p>
            <div className="status-check green"><window.Icon name="check" size={12} /></div>
          </div>
          <div className="arrow green">→</div>
          <div className="node active">
            <window.Icon name="edit" size={20} />
            <h4>Script Writer</h4>
            <p>Draft engaging script</p>
            <div className="status-spinner"><window.Icon name="loader" size={12} className="spin" /></div>
          </div>
          <div className="arrow">→</div>
          <div className="node">
            <window.Icon name="search" size={20} />
            <h4>SEO Optimizer</h4>
            <p>Keywords & optimization</p>
          </div>
          <div className="arrow">→</div>
          <div className="node">
            <window.Icon name="shield" size={20} />
            <h4>Final Review</h4>
            <p>Quality check & approval</p>
          </div>
        </div>
      </div>

      <div className="dash-bottom-grid">
        <div className="dash-col-left">
          <div className="dash-panel">
            <div className="panel-header">
              <h3><window.Icon name="activity" size={16} /> Live Run Log</h3>
              <a href="#">View all logs</a>
            </div>
            <div className="log-table">
              <div className="log-row">
                <span className="time">10:24:31</span>
                <window.Icon name="check-circle" size={14} className="green-text" />
                <span className="msg">Build fix applied: Corrected I2S pin mapping for ESP32-S3</span>
                <span className="tag blue">Code Agent</span>
              </div>
              <div className="log-row">
                <span className="time">10:22:17</span>
                <window.Icon name="check-circle" size={14} className="green-text" />
                <span className="msg">Generated wiring plan for MAX98357A audio amp</span>
                <span className="tag purple">Planner Agent</span>
              </div>
              <div className="log-row yellow-bg">
                <span className="time">10:20:05</span>
                <window.Icon name="clock" size={14} className="yellow-text" />
                <span className="msg yellow-text">Approval needed: Email Agent wants to contact seller about item details</span>
                <span className="tag yellow">Approval</span>
              </div>
              <div className="log-row">
                <span className="time">10:18:42</span>
                <window.Icon name="check-circle" size={14} className="green-text" />
                <span className="msg">Researched 12 marketplace listings and extracted key specs</span>
                <span className="tag green">Research Agent</span>
              </div>
              <div className="log-row">
                <span className="time">10:16:23</span>
                <window.Icon name="check-circle" size={14} className="green-text" />
                <span className="msg">Workflow started: Marketplace Laptop Checker</span>
                <span className="tag gray">System</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dash-col-right">
          <div className="dash-panel">
            <div className="panel-header">
              <h3><window.Icon name="activity" size={16} /> Agent Status</h3>
              <a href="#">View all</a>
            </div>
            <div className="status-list">
              <div className="status-item"><span className="dot green"></span> Research Agent <span>Online</span></div>
              <div className="status-item"><span className="dot green"></span> Code Agent <span>Online</span></div>
              <div className="status-item"><span className="dot yellow"></span> Planner Agent <span>Busy</span></div>
              <div className="status-item"><span className="dot green"></span> Email Agent <span>Online</span></div>
              <div className="status-item"><span className="dot green"></span> Browser Agent <span>Online</span></div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3><window.Icon name="server" size={16} /> System Health</h3>
              <a href="#">View details</a>
            </div>
            <div className="health-stats">
              <div className="stat-row">
                <span><window.Icon name="cpu" size={14} /> CPU</span>
                <div className="val">24% <div className="mini-bar"><div className="fill green" style={{width:'24%'}}></div></div></div>
              </div>
              <div className="stat-row">
                <span><window.Icon name="database" size={14} /> RAM</span>
                <div className="val">42% <div className="mini-bar"><div className="fill green" style={{width:'42%'}}></div></div></div>
              </div>
              <div className="stat-row">
                <span><window.Icon name="layers" size={14} /> Queue</span>
                <div className="val">7 <div className="mini-bar"><div className="fill green" style={{width:'100%'}}></div></div></div>
              </div>
              <div className="stat-row">
                <span><window.Icon name="alert-triangle" size={14} /> Errors (24h)</span>
                <div className="val">0</div>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3><window.Icon name="shield" size={16} /> Approvals</h3>
              <a href="#">View all</a>
            </div>
            <div className="approval-card">
              <span className="tag yellow mb-2">PENDING</span>
              <span className="time right">2m ago</span>
              <p>Email Agent wants approval to contact seller</p>
              <div className="appr-actions">
                <button className="dash-btn green"><window.Icon name="check" size={14} /> Approve</button>
                <button className="dash-btn sub"><window.Icon name="edit" size={14} /> Edit</button>
                <button className="dash-btn red"><window.Icon name="x" size={14} /> Reject</button>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3><window.Icon name="database" size={16} /> Memory</h3>
              <a href="#">View all</a>
            </div>
            <div className="memory-list">
              <div className="mem-header">
                <span>Project Memory</span>
                <span className="tag green">4 items</span>
              </div>
              <div className="mem-item">
                <window.Icon name="database" size={14} className="gray-text" />
                <span className="mem-name">ESP32-S3</span>
                <span className="mem-type">Microcontroller</span>
                <span className="mem-time">Added 10m ago</span>
              </div>
              <div className="mem-item">
                <window.Icon name="database" size={14} className="gray-text" />
                <span className="mem-name">Round LCD 240x240</span>
                <span className="mem-type">Display</span>
                <span className="mem-time">Added 15m ago</span>
              </div>
              <div className="mem-item">
                <window.Icon name="database" size={14} className="gray-text" />
                <span className="mem-name">MAX98357A</span>
                <span className="mem-type">Audio Amplifier</span>
                <span className="mem-time">Added 18m ago</span>
              </div>
              <div className="mem-item">
                <window.Icon name="database" size={14} className="gray-text" />
                <span className="mem-name">Dual MEMS Microphones</span>
                <span className="mem-type">Audio Input</span>
                <span className="mem-time">Added 22m ago</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DashboardTab });
