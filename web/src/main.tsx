import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Badge, Container, Nav, Navbar } from 'react-bootstrap'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import './style.css'
import { CatalogSearch } from './search.js'

function App() {
  return (
    <>
      <Navbar bg="dark" variant="dark" expand="lg">
        <Container fluid className="shell">
          <Navbar.Brand as={NavLink} to="/" className="font-monospace">catalog-sync</Navbar.Brand>
          <Badge bg={import.meta.env.VITE_CATALOG_ENV === 'PROD' ? 'primary' : 'secondary'} className="me-4">
            {import.meta.env.VITE_CATALOG_ENV === 'PROD' ? 'PROD' : 'LOCAL'}
          </Badge>
          <Navbar.Toggle aria-controls="site-nav" />
          <Navbar.Collapse id="site-nav">
            <Nav>
              <Nav.Link as={NavLink} to="/" end>Catalog Search</Nav.Link>
            </Nav>
          </Navbar.Collapse>
        </Container>
      </Navbar>
      <Container as="main" fluid className="shell py-3">
        <Routes>
          <Route path="/" element={<CatalogSearch />} />
        </Routes>
      </Container>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </React.StrictMode>,
)
